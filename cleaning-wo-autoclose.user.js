// ==UserScript==
// @name         UBIF Portal — Cleaning WO one-click close
// @namespace    garrett.ubif
// @version      1.1
// @description  On a cleaning-program arrival, adds a button next to "Check-in" that checks it in, walks the WO to Ready for pickup, and completes the $0 sale — with a Stop button while it runs.
// @match        https://portal.ubreakifix.net/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
  Replays the exact API sequence the portal's own UI makes for a cleaning WO
  (captured Sep 26, 2026 — see the vault note "Cleaning WO Flow"):

    check-in    validate-imei → checkin/workorder → calculate-sla →
                update-service-job-status → PUT checkin/workorder   (status 8)
    status walk PATCH status 9, then PUT workorder 10 → 11 → 12 → 13,
                each followed by the same auto-note the UI posts
    checkout    verify cart total is $0 → checkout/complete-order

  Deliberately NOT replayed (the UI does them, the flow shouldn't need them):
    - PUT /api/checkin/customers/{id}  — would re-save the customer record
    - PUT /api/customer-devices/{id}   — would blank the shared device's
                                         nickname/passcode (the parent WO's)
  If check-in fails on a first real run, these are the first suspects.

  @match is the whole portal (SPA — see the Galaxy script's note); tick()
  checks the path itself. @grant none so fetch() is the page's own, with
  the logged-in session cookie.
*/

const CONFIG = {
  // Cleaning programs from the ubif-workorders audit rules (VEW and Asurion
  // Mobility 5062 are NOT cleanings). 10303 = AT&T Performance Check, whose
  // line item is "AT&T In-Person Performance Promise".
  CLEANING_PROGRAM_IDS: {
    11759: 'Verizon In-Person Device Refresh',
    9470: 'Verizon Mobile Device Sanitization',
    11009: 'AT&T Enhanced Device Cleaning',
    9901: 'AT&T Device Diagnostic',
    10303: 'AT&T Performance Check',
  },
  DEVICE_ISSUES: ['Cleaning'],
  BIN: '', // cleanings aren't physical — no bin. Set e.g. 'N/A' if the portal starts requiring one.
  STEP_DELAY_MS: 400, // small pause between calls, roughly UI pacing
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(function main() {
  if (location.hostname !== 'portal.ubreakifix.net') return;

  const BTN_ID = 'cwo-autoclose-btn';
  const PANEL_ID = 'cwo-autoclose-panel';
  let checkedArrivalId = null; // arrival we've already looked up
  let isCleaning = false;
  let running = false;
  let stopRequested = false;

  // ---------------------------------------------------------------- API
  class Stopped extends Error {}

  async function api(method, path, body) {
    if (stopRequested) throw new Stopped();
    const init = { method, credentials: 'include', headers: { accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new Error('Session expired — log in again (HTTP ' + res.status + ' on ' + path + ')');
    if (!res.ok) throw new Error(method + ' ' + path + ' → HTTP ' + res.status + ': ' + text.slice(0, 200));
    if (/^\s*<!doctype html/i.test(text)) throw new Error(method + ' ' + path + ' returned the app shell, not JSON (wrong route?)');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = text; }
    await sleep(CONFIG.STEP_DELAY_MS);
    return json;
  }
  const unwrap = (j) => (j && j.data && !Array.isArray(j.data) ? j.data : j);

  // ------------------------------------------------------------- the run
  async function run(arrivalId, log) {
    const arrival = unwrap(await api('GET', '/api/arrivals/' + arrivalId));
    const programId = arrival.program && arrival.program.programId;
    if (!CONFIG.CLEANING_PROGRAM_IDS[programId]) throw new Error('Not a cleaning program (' + programId + ') — refusing.');
    const dev = arrival.customerDevice || {};
    const customerId = String(arrival.customer.customerId);
    const clientId = arrival.clientId;
    const storeId = arrival.storeId;
    const serviceJobId = arrival.partnerJobDetails && arrival.partnerJobDetails.serviceJobId;

    const user = unwrap(await api('GET', '/api/auth/user'));
    const tech = [user.givenName, user.familyName].filter(Boolean).join(' ');

    // 1. IMEI — the arrival carries all 15 digits (the drawer masks the last).
    //    Try the known last digit first, then the rest of 0–9.
    const imei = String(dev.imei || '');
    if (!/^\d{14,15}$/.test(imei)) throw new Error('No usable IMEI on this arrival — check in by hand.');
    const first14 = imei.slice(0, 14);
    const candidates = imei.length === 15
      ? [imei[14], ...'0123456789'.split('').filter((d) => d !== imei[14])]
      : '0123456789'.split('');
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
      await api('POST', '/api/checkin/update-service-job-status/' + encodeURIComponent(serviceJobId), {
        scenario: 'Create work order', arrivalId, programId,
      });
    }
    await api('PUT', '/api/checkin/workorder', {
      workorderId: woId, deviceIssues: CONFIG.DEVICE_ISSUES, deviceDiagNotes: [], additionalDetails: '',
      customerDeviceId: String(dev.customerDeviceId), itemswithdevice: [],
      estimateRepairTime: (sla && sla.estimateEndTime) || new Date(Date.now() + 2 * 3600e3).toISOString(),
      quotedPrice: '0', isWarrantyVoided: false, arrivalId, isImeiUnavailable: false, isSerialUnavailable: false,
      quoteId: null, binLocation: CONFIG.BIN,
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
          workorderId: woId, workorderStatusId: 13, sendComms: false, workorderBin: CONFIG.BIN, storeId,
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

  // ------------------------------------------------------------------ UI
  function panel() {
    let p = document.getElementById(PANEL_ID);
    if (p) return p;
    p = document.createElement('div');
    p.id = PANEL_ID;
    p.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;width:320px;background:#fff;color:#111;' +
      'border:2px solid #6700b8;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.25);font:13px/1.4 system-ui,sans-serif;padding:12px';
    if (!document.getElementById(PANEL_ID + '-css')) {
      const css = document.createElement('style');
      css.id = PANEL_ID + '-css';
      css.textContent =
        '@keyframes cwo-spin{to{transform:rotate(360deg)}}' +
        '@keyframes cwo-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}' +
        '#' + PANEL_ID + ' [data-spin]{width:16px;height:16px;flex:none;box-sizing:border-box;border:2px solid #e3d1f2;border-top-color:#6700b8;border-radius:50%;animation:cwo-spin .7s linear infinite}' +
        '#' + PANEL_ID + ' [data-spin].done{animation:none;border:0;width:auto;height:auto;font-size:15px;line-height:16px}' +
        '#' + PANEL_ID + ' [data-log] li{display:flex;gap:8px;align-items:baseline;padding:2px 0;animation:cwo-in .2s ease-out}' +
        '#' + PANEL_ID + ' [data-log] li::before{content:"✓";color:#2e7d32;font-weight:700;flex:none}';
      document.head.appendChild(css);
    }
    p.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<span data-spin></span><b style="flex:1">Cleaning WO auto-close</b>' +
      '<span data-clock style="font-variant-numeric:tabular-nums;color:#555">0.0s</span>' +
      '<span data-x style="cursor:pointer;display:none;font-size:16px;margin-left:4px">✕</span></div>' +
      '<ul data-log style="list-style:none;margin:0 0 10px;padding:0;max-height:220px;overflow:auto"></ul>' +
      '<div data-msg style="display:none;border-radius:6px;padding:6px 8px;margin-bottom:8px"></div>' +
      '<button data-stop style="width:100%;padding:10px;border:0;border-radius:8px;background:#c62828;color:#fff;font-weight:600;font-size:14px;cursor:pointer">■ Stop</button>';
    p.querySelector('[data-stop]').onclick = () => {
      stopRequested = true;
      const b = p.querySelector('[data-stop]');
      b.textContent = 'Stopping after current call…';
      b.disabled = true;
    };
    p.querySelector('[data-x]').onclick = () => p.remove();
    document.body.appendChild(p);
    return p;
  }

  function woLink(woId) {
    return '<a href="/repair/workorder/' + woId + '" style="color:#6700b8">WO ' + woId + '</a>';
  }

  async function onClick(arrivalId) {
    if (running) return;
    running = true;
    stopRequested = false;
    document.getElementById(PANEL_ID)?.remove();
    const p = panel();
    const list = p.querySelector('[data-log]');
    const msg = p.querySelector('[data-msg]');
    let woId = null;
    const log = (t, id) => {
      if (id) woId = id;
      const li = document.createElement('li');
      li.textContent = t;
      list.appendChild(li);
      list.scrollTop = list.scrollHeight;
    };
    // Runtime clock — ticks while running, frozen by finish().
    const clock = p.querySelector('[data-clock]');
    const t0 = performance.now();
    const fmt = (ms) => {
      const s = ms / 1000;
      return s < 60 ? s.toFixed(1) + 's' : Math.floor(s / 60) + 'm ' + String(Math.floor(s % 60)).padStart(2, '0') + 's';
    };
    const clockTimer = setInterval(() => { clock.textContent = fmt(performance.now() - t0); }, 100);
    const finish = (html, ok, icon) => {
      clearInterval(clockTimer);
      clock.textContent = fmt(performance.now() - t0);
      const spin = p.querySelector('[data-spin]');
      spin.classList.add('done');
      spin.textContent = icon;
      spin.style.color = ok ? '#2e7d32' : '#c62828';
      msg.style.display = 'block';
      msg.style.background = ok ? '#e8f5e9' : '#ffebee';
      msg.style.color = ok ? '#1b5e20' : '#b71c1c';
      msg.innerHTML = html;
      p.querySelector('[data-stop]').style.display = 'none';
      p.querySelector('[data-x]').style.display = 'inline';
    };
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.disabled = true;
    try {
      const id = await run(arrivalId, log);
      finish('✓ Done — ' + woLink(id) + ' checked in, completed, and sold at $0.', true, '✓');
    } catch (e) {
      const where = woId ? ' ' + woLink(woId) + ' was left at the last step listed above.' : ' No work order was created.';
      const stopped = e instanceof Stopped;
      finish(stopped ? '■ Stopped.' + where : '✕ ' + String(e.message).replace(/</g, '&lt;') + where, false, stopped ? '■' : '✕');
    } finally {
      running = false;
      if (btn) btn.disabled = false;
    }
  }

  function portalCheckinButton() {
    return [...document.querySelectorAll('button')].find((b) => b.offsetParent && b.textContent.trim() === 'Check-in');
  }

  async function tick() {
    const m = location.pathname.match(/^\/check-in\/arrivals\/(\d+)$/);
    const existing = document.getElementById(BTN_ID);
    if (!m) { existing?.remove(); checkedArrivalId = null; return; }
    const arrivalId = Number(m[1]);

    if (checkedArrivalId !== arrivalId) {
      checkedArrivalId = arrivalId;
      isCleaning = false;
      existing?.remove();
      try {
        const a = unwrap(await (await fetch('/api/arrivals/' + arrivalId, { credentials: 'include', headers: { accept: 'application/json' } })).json());
        isCleaning = !!CONFIG.CLEANING_PROGRAM_IDS[a && a.program && a.program.programId];
      } catch (_) { checkedArrivalId = null; } // retry next tick
    }
    if (!isCleaning) return;

    const checkin = portalCheckinButton();
    if (!checkin || document.getElementById(BTN_ID)) return;
    const b = document.createElement('button');
    b.id = BTN_ID;
    b.type = 'button';
    b.textContent = '⚡ Auto-close cleaning';
    b.title = 'Check in, walk to Ready for pickup, and complete the $0 sale';
    b.style.cssText = 'margin-right:8px;padding:0 18px;height:' + (checkin.offsetHeight || 40) + 'px;border-radius:999px;border:2px solid #6700b8;' +
      'background:#fff;color:#6700b8;font:600 14px system-ui,sans-serif;cursor:pointer';
    b.onclick = () => onClick(arrivalId);
    checkin.parentElement.insertBefore(b, checkin);
  }

  setInterval(tick, 1000); // SPA — poll for route/DOM changes
  tick();
})();
