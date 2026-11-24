/*
  Morning check — Portal's side of Linkpearl's morning check: read a work order, and change its status, bin location, device
  nickname, or add a note. Linkpearl drives it over Linkshell (check.* kinds); dev tools has test buttons for each change.

  Which Portal calls are proven (captured from Portal's own UI) and which are still guesses:
    nickname  PUT /api/customer-devices/{id}, the device record back unchanged apart from name   proven (Waymark)
    note      POST /api/note { noteText, customerId, workorderId, noteTag, noteType: 2 }           proven (Recitation, Provoke)
              customerId: the order's CustomerDevice.customerId (the detail has none at the top), else
              GET /api/v1/workorder/{id}/demographic/customer-data (Recitation)
    status    8 → 9: PATCH /api/workorder/{id}/status { workorderStatusId }                         proven (Swiftcast)
              9 → 10 → 11 → 12: PUT /api/workorder/{id} (the order back, + workorderStatusId,
              markCurrentStepCompleted), then the step's note                                       proven (Swiftcast)
              12 → 13: POST /api/workorder/attribute (service_outcome, workorderBin), then the PUT  proven (Swiftcast)
              any other move                                                                       GUESS: same PUT, no note
    bin       GUESS: the PUT with workorderBin (the attribute call's name) and binLocation (check-in's name),
              then the order is read again and the change fails unless Portal kept the new bin
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
  async function customerOf(wo, woId) {
    const id = wo.CustomerDevice && wo.CustomerDevice.customerId;
    if (id != null && id !== '') return String(id);
    const c = await api('GET', '/api/v1/workorder/' + woId + '/demographic/customer-data');
    if (c && c.customerId != null && c.customerId !== '') return String(c.customerId);
    throw new Error('No customer on this work order');
  }
  async function note(wo, woId, tag, text, type) {
    return api('POST', '/api/note', { noteText: text, customerId: await customerOf(wo, woId), workorderId: Number(woId), noteTag: tag || null, noteType: type || 1 });
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
    const to = String(bin || '').trim();
    await api('PUT', '/api/workorder/' + woId, putBody(wo, { workorderBin: to, binLocation: to, sendComms: false }));
    changed(woId, 'bin');
    const after = await read(woId);
    if (after.bin.trim().toLowerCase() !== to.toLowerCase()) throw new Error('Portal didn\'t take the new location');
    return after;
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

/*
  Over Linkshell: Linkpearl's morning check. The phone asks, the PC lists its open work orders, and the phone's changes are made
  here with the calls above, one work order at a time. The PC acts only while its Morning check panel is open: a PC shows the
  ask and someone allows it there; a Linkshell host link (link.host) opens it by itself.

    phone → PC  check.start   { run }                                       ask for a check (run: the phone's id for it)
    PC → phone  check.list    { run, part, parts, store, statuses, rows }  the open work orders, in parts
                  rows: [[wo, statusId, bin, nickname, device, issue, customer, program, updatedAt], …]
                  statuses: [[id, name, [ids it can move to from the phone]], …]; bins: false while bin changes are still guesses
    phone → PC  check.set     { run, cid, wo, updatedAt, status?, bin?, nickname?, note? }   one work order's changes
    PC → phone  check.result  { run, cid, wo, ok, row, failed: [[field, message], …] }        what Portal took, and the order after
    phone → PC  check.progress { run, done, total }                         the panel's count
    either      check.end     { run, reason? }                              finished, stopped, or declined on the PC
  Changes run in a fixed order (nickname, note, bin, status) and each is reported on its own; the first write is refused when the
  order changed in Portal since the phone's copy (updatedAt). Only proven calls run from the phone (see the top of this file).
*/
AE.morningCheck.link = (() => {
  if (typeof AE.linkshell === 'undefined' || !AE_ON_PORTAL) return null;
  const L = AE.linkshell, MC = AE.morningCheck;
  const PART = 15;
  const LIVE = { bin: true }; // bin changes: the guessed call, checked by reading the order back (see top)
  let run = null; // { id, total, done, changed, log: [] , panel }

  // The moves the phone may make from each status: proven calls only, and never past Work in progress.
  const movesFrom = (from) => MC.PHONE_STATUSES.filter((to) => to !== from && MC.statusPlan(from, to).proven);

  const rowOf = (r) => [String(r.workorderId), r.workorderStatusId, r.locationBin || '', (r.customerDevice && r.customerDevice.name) || '',
    (r.deviceCatalog && r.deviceCatalog.name) || '', (r.deviceIssues || []).map((x) => (x && (x.name || x.issueName)) || x).filter((x) => typeof x === 'string').join(', '),
    AE.data.nameOf(r) || '', r.programName || '', r.updatedAt || ''];

  async function sendList(id) {
    const store = (await AE.profile()).storeId;
    const rows = (await AE.data.workorders(Date.now(), 0)).map(rowOf);
    const statuses = Object.entries(MC.STATUS).map(([s, n]) => [Number(s), n, movesFrom(Number(s))]);
    const parts = Math.max(1, Math.ceil(rows.length / PART));
    for (let p = 0; p < parts; p++) L.send('check.list', { run: id, part: p, parts, store: String(store), bins: LIVE.bin, statuses: p === 0 ? statuses : [], rows: rows.slice(p * PART, (p + 1) * PART) });
    return rows.length;
  }

  async function apply(b) {
    const failed = [], wo = String(b.wo || '');
    if (!/^\d{1,12}$/.test(wo)) return { failed: [['wo', 'Not a work order']], row: null };
    let before = null;
    try { before = await MC.read(wo); } catch (e) { return { failed: [['wo', (e && e.message) || String(e)]], row: null }; }
    if (b.updatedAt && before.updatedAt && b.updatedAt !== before.updatedAt) failed.push(['wo', 'Changed in Portal since']);
    else {
      const step = async (field, fn) => { try { await fn(); } catch (e) { failed.push([field, (e && (e.portalMessage || e.message)) || String(e)]); } };
      if (typeof b.nickname === 'string') await step('nickname', () => MC.setNickname(wo, b.nickname.slice(0, 60)));
      if (typeof b.note === 'string' && b.note.trim()) await step('note', () => MC.addNote(wo, b.note.slice(0, 2000)));
      if (typeof b.bin === 'string') await step('bin', () => { if (!LIVE.bin) throw new Error('Not available yet'); return MC.setBin(wo, b.bin.slice(0, 40)); });
      if (b.status != null) await step('status', async () => {
        const now = await MC.read(wo);
        if (!movesFrom(now.statusId).includes(Number(b.status))) throw new Error('Change this status in Portal');
        return MC.setStatus(wo, Number(b.status));
      });
    }
    let row = null;
    try { const r = await MC.read(wo); row = [r.wo, r.statusId, r.bin, r.nickname, r.updatedAt]; } catch (_) {}
    return { failed, row };
  }

  // ---------------------------------------------------------------- the panel
  const ID = 'ae-morning-check';
  function css() {
    if (document.getElementById(ID + '-css')) return;
    document.head.append(AE.h('style', { id: ID + '-css' }, `
      #${ID} { position:fixed; right:16px; bottom:16px; z-index:2147483640; width:340px; padding:16px; }
      #${ID} .hd { display:flex; align-items:center; gap:10px; }
      #${ID} .hd h4 { margin:0; font-size:16px; flex:1; }
      #${ID} .st { height:24px; padding:0 10px; border-radius:12px; font-size:12px; font-weight:700; display:inline-flex; align-items:center;
        background:var(--aui-status-success-soft, #c5ffc8); color:var(--aui-status-success, #136d31); }
      #${ID} .bar { height:6px; border-radius:3px; background:var(--aui-neutral-soft, #e3e2e7); overflow:hidden; margin:14px 0 6px; }
      #${ID} .bar b { display:block; height:100%; background:var(--aui-primary, #8223d2); }
      #${ID} .ct { display:flex; justify-content:space-between; font-weight:600; font-size:13px; }
      #${ID} ul { margin:12px 0 0; padding:0; list-style:none; font-size:13px; max-height:180px; overflow:auto; }
      #${ID} li { display:flex; gap:8px; padding:7px 0; border-top:1px solid var(--aui-outline-soft, #eeedf1); }
      #${ID} li b { min-width:78px; } #${ID} li span { flex:1; color:var(--aui-on-surface-soft, #5d5e61); }
      #${ID} li i { font-style:normal; font-weight:700; color:var(--aui-status-success, #136d31); } #${ID} li i.r { color:var(--aui-status-error, #b91a24); }
      #${ID} .sg-actions { margin-top:12px; }
    `));
  }
  function panel() {
    css();
    let el = document.getElementById(ID);
    if (!el) { el = AE.h('div', { id: ID, class: 'sg sg-card', role: 'dialog', 'aria-label': 'Morning check' }); document.body.append(el); }
    return el;
  }
  const close = () => { const el = document.getElementById(ID); if (el) el.remove(); };
  const phoneName = () => (L.linked() || {}).phoneName || 'Linkpearl';
  const btn = (label, onclick, primary) => AE.h('button', { type: 'button', class: 'sg-btn sg-lg' + (primary ? ' sg-primary' : ''), onclick }, label);
  const head = () => AE.h('div', { class: 'hd' }, AE.h('span', { html: AE.actionIcon('linkshell', 30) || AE.icon('aetheryte', 30), style: 'line-height:0' }), AE.h('h4', null, 'Morning check'), AE.h('span', { class: 'st' }, phoneName()));

  function draw() {
    if (!run) return close();
    const el = panel(), pct = run.total ? Math.round((run.done / run.total) * 100) : 0;
    el.replaceChildren(head(), AE.h('div', { class: 'bar' }, AE.h('b', { style: 'width:' + pct + '%' })),
      AE.h('div', { class: 'ct' }, AE.h('b', null, run.done + ' / ' + run.total), AE.h('span', { class: 'sg-soft' }, run.changed ? run.changed + ' changed' : '')),
      run.log.length ? AE.h('ul', null, ...run.log.slice(0, 20).map((x) => AE.h('li', null, AE.h('b', null, x.wo), AE.h('span', null, x.what), AE.h('i', { class: x.ok ? '' : 'r' }, x.ok ? 'Saved' : 'Failed')))) : null,
      AE.h('div', { class: 'sg-actions' }, btn('Stop', () => stop())));
  }
  function ask(id) {
    return new Promise((resolve) => {
      const el = panel();
      el.replaceChildren(head(), AE.h('div', { class: 'sg-actions' }, btn('Decline', () => { close(); resolve(false); }), btn('Allow', () => resolve(true), true)));
    });
  }
  function stop(reason) {
    if (run) L.send('check.end', { run: run.id, reason: reason || 'stopped' });
    run = null; close();
  }

  // ---------------------------------------------------------------- messages
  L.on('check.start', async (b) => {
    const id = String((b && b.run) || '').slice(0, 40);
    if (!id) return;
    if (run && run.id === id) { await sendList(id); return; } // the phone reopened it
    const link = L.linked() || {};
    if (!link.host) {
      const ok = await ask(id);
      if (!ok) { L.send('check.end', { run: id, reason: 'declined' }); return; }
    }
    AE.track('morningCheck');
    run = { id, total: 0, done: 0, changed: 0, log: [] };
    try { run.total = await sendList(id); } catch (e) { L.send('check.end', { run: id, reason: 'failed' }); run = null; close(); AE.noteError('morning check list', e); return; }
    draw();
  });
  L.on('check.set', async (b) => {
    if (!run || !b || b.run !== run.id) { L.send('check.result', { run: b && b.run, cid: b && b.cid, wo: b && b.wo, ok: false, failed: [['check', 'Not running on the PC']] }); return; }
    const { failed, row } = await apply(b);
    const what = [b.bin != null ? b.bin : null, b.status != null ? MC.STATUS[b.status] : null, b.nickname != null ? 'Nickname' : null, b.note ? 'Note' : null].filter(Boolean).join(' · ');
    if (!failed.length) run.changed++;
    run.log.unshift({ wo: String(b.wo), what, ok: !failed.length });
    L.send('check.result', { run: run.id, cid: b.cid, wo: String(b.wo), ok: !failed.length, row, failed });
    draw();
  });
  L.on('check.progress', (b) => { if (run && b && b.run === run.id) { run.done = Math.max(0, Number(b.done) || 0); run.total = Number(b.total) || run.total; draw(); } });
  L.on('check.end', (b) => { if (run && b && b.run === run.id) { run = null; close(); } });

  return { _test: { apply, movesFrom, rowOf, LIVE }, state: () => run };
})();
