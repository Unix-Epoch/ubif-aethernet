/*
  Morning check — Portal's side of Linkpearl's morning check: read a work order, and change its status, bin location, device
  nickname, or add a note. Linkpearl drives it over Linkshell (check.* kinds); dev tools has test buttons for each change.

  Which Portal calls are proven (captured from Portal's own UI) and which are still guesses:
    nickname  PUT /api/customer-devices/{id}, the device record back unchanged apart from name   proven (Waymark)
    note      POST /api/note { noteText, customerId, workorderId, noteTag, noteType: 2 }           proven (Recitation, Provoke)
    status    8 → 9: PATCH /api/workorder/{id}/status { workorderStatusId }                         proven (Swiftcast)
              9 → 10 → 11 → 12: PUT /api/workorder/{id} (the order back, + workorderStatusId,
              markCurrentStepCompleted), then the step's note                                       proven (Swiftcast)
              12 → 13: POST /api/workorder/attribute (service_outcome, workorderBin), then the PUT  proven (Swiftcast)
              any other move                                                                       GUESS: same PUT, no note
    bin       GUESS: the PUT with workorderBin (the name Portal's attribute call uses)
  Guesses are dev-only test buttons until the dev recorder (dev tools → Portal request recorder) has Portal's real call.
  Customer texts: every status call sends sendComms: false.
*/
AE.morningCheck = (() => {
  const api = (...a) => AE.api(...a);
  const STATUS = {
    2: 'Need to order', 3: 'Awaiting item', 4: 'Awaiting device', 5: 'Awaiting diagnostics', 6: 'Awaiting partner approval', 7: 'Awaiting callback',
    8: 'Ready for work', 24: 'Ready for diag', 9: 'Diagnostics', 10: 'Work in progress', 11: 'Quality check', 12: 'Repair summary', 13: 'Ready for pickup',
  };
  const TAG = { 2: 'need_to_order', 3: 'awaiting_item', 4: 'awaiting_device', 5: 'awaiting_diagnostics', 6: 'awaiting_partner_approval', 7: 'awaiting_callback',
    8: 'ready_for_work', 9: 'diagnostics', 10: 'work_in_progress', 11: 'quality_check', 12: 'repair_summary', 13: 'ready_for_pickup', 24: 'ready_for_diag' };
  // Moves Linkpearl may make: up to Work in progress. Past it stays in Portal until those calls are recorded.
  const PHONE_STATUSES = [8, 24, 9, 10, 2, 3, 4, 5, 6, 7];

  const raw = async (woId) => AE.shape.workorder(await api('GET', '/api/workorder/' + woId), 'Morning check work order ' + woId);
  const binOf = (wo) => { const b = wo.WorkorderBinDeviceLocation && wo.WorkorderBinDeviceLocation.WorkorderBin; return (b && b.name) || ''; };

  // What the phone sees of a work order.
  async function read(woId) {
    const wo = await raw(woId);
    const dev = wo.CustomerDevice || {};
    return { wo: String(woId), statusId: wo.workorderStatusId, status: STATUS[wo.workorderStatusId] || '', bin: binOf(wo), nickname: dev.name || '', updatedAt: wo.updatedAt || null };
  }

  // The order to PUT back: Portal's own answer, never one built from a malformed answer.
  const putBody = (wo, extra) => { const b = Object.assign({}, wo, extra); delete b.workorderId; return b; };
  // noteType 1: Portal's automatic step notes (Swiftcast); 2: a note typed by hand (Recitation, Provoke).
  async function note(wo, woId, tag, text, type) {
    return api('POST', '/api/note', { noteText: text, customerId: String(wo.customerId), workorderId: Number(woId), noteTag: tag || null, noteType: type || 1 });
  }
  const sameStore = async (wo) => { const p = await AE.profile(); if (wo.storeId != null && p && Number(wo.storeId) !== Number(p.storeId)) throw new Error('Another store\'s work order'); return p; };

  /*
    The calls a change makes, as a plan (shown by the dev test buttons before anything is sent), then run.
    opts.method: 'auto' (the proven call when there is one, else the PUT), 'patch' or 'put' (dev tests).
  */
  function statusPlan(from, to, opts = {}) {
    const m = opts.method || 'auto';
    const proven = (from === 8 && to === 9) || (from >= 9 && from <= 12 && to === from + 1);
    const kind = m === 'patch' || (m === 'auto' && from === 8 && to === 9) ? 'patch' : 'put';
    return { from, to, kind, proven: proven && !(kind === 'patch' && to !== 9) && !(kind === 'put' && from === 8 && to === 9), rfp: to === 13 };
  }
  async function setStatus(woId, to, opts = {}) {
    to = Number(to);
    if (!STATUS[to]) throw new Error('Unknown status ' + to);
    const wo = await raw(woId);
    const p = await sameStore(wo);
    if (opts.updatedAt && wo.updatedAt && opts.updatedAt !== wo.updatedAt) throw Object.assign(new Error('Changed in Portal since'), { stale: true });
    const from = wo.workorderStatusId;
    if (from === to) return read(woId);
    const plan = statusPlan(from, to, opts);
    if (plan.rfp) {
      await api('POST', '/api/workorder/attribute', {
        workorderId: Number(woId), workorderStatusId: 13, sendComms: false, workorderBin: opts.bin != null ? opts.bin : binOf(wo), storeId: wo.storeId,
        WorkorderAttribute: [{ workorderId: Number(woId), workorderAttributeTypeId: 22, key: 'service_outcome', value: 'Completed' }],
      });
    }
    if (plan.kind === 'patch') await api('PATCH', '/api/workorder/' + woId + '/status', { workorderStatusId: to });
    else await api('PUT', '/api/workorder/' + woId, putBody(wo, Object.assign({ workorderStatusId: to, markCurrentStepCompleted: to > from, sendComms: false }, from === 9 && to === 10 ? { completedWorkorderStatusId: 9, note: '' } : {})));
    const tech = (p && p.name) || 'Aethernet';
    // The step notes Portal's UI posts, where they are known (Swiftcast's walk).
    const STEP_NOTE = { 9: tech + ' started work.', 10: tech + '  completed diagnostics.', 11: tech + ' completed work.', 12: tech + ' completed quality check.',
      13: tech + ' marked the device as "Ready for pickup." - Completed' };
    if (plan.proven && STEP_NOTE[to]) await note(wo, woId, to === 9 ? 'ready_for_work' : to === 13 ? 'ready_for_pickup' : TAG[from], STEP_NOTE[to]);
    changed(woId, 'status');
    return read(woId);
  }

  // GUESS (see top): the order PUT back with the new bin.
  async function setBin(woId, bin, opts = {}) {
    const wo = await raw(woId);
    await sameStore(wo);
    if (opts.updatedAt && wo.updatedAt && opts.updatedAt !== wo.updatedAt) throw Object.assign(new Error('Changed in Portal since'), { stale: true });
    await api('PUT', '/api/workorder/' + woId, putBody(wo, { workorderBin: String(bin || ''), sendComms: false }));
    changed(woId, 'bin');
    return read(woId);
  }

  // Proven (Waymark): the device record back unchanged apart from name.
  async function setNickname(woId, name) {
    const wo = await raw(woId);
    await sameStore(wo);
    const dev = wo.CustomerDevice;
    if (!dev || !dev.customerDeviceId) throw new Error('No device on this work order');
    await api('PUT', '/api/customer-devices/' + dev.customerDeviceId, {
      customerDeviceId: dev.customerDeviceId, customerId: dev.customerId, passcode: dev.passcode, serial: dev.serial,
      imei: dev.imei, deviceCatalogId: dev.deviceCatalogId, name: String(name || ''),
    });
    changed(woId, 'nickname');
    return read(woId);
  }

  async function addNote(woId, text) {
    const t = String(text || '').trim();
    if (!t) throw new Error('Empty note');
    const wo = await raw(woId);
    await sameStore(wo);
    await note(wo, woId, TAG[wo.workorderStatusId], t, 2);
    changed(woId, 'note');
    return read(woId);
  }

  function changed(woId, why) {
    AE.emit('wo-changed', { woId: String(woId), why });
    if (location.pathname.indexOf('/repair/workorder/' + woId) === 0) AE.refreshView();
  }

  return { STATUS, PHONE_STATUSES, read, statusPlan, setStatus, setBin, setNickname, addNote, _test: { binOf, putBody } };
})();
