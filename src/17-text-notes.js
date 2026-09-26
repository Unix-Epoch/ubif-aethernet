/*
  Text → WO note. When a text is sent to a customer from inside a work
  order, post it as a note on that WO:

    Garrett Green sent a text message to Grace Beech.

    <the message>

  How: watches the portal's own send call (POST …/messages/v1/send, the
  chat panel's sendMessage mutation) by wrapping the page's fetch. Only
  after the portal reports the text was sent does it post the note, so a
  failed send never gets logged. It never sends texts itself.

  Send body (from the portal's code): { customerId, workorderId,
  communicationType: 'SMS', message, messageDestination, messageSource,
  senderTechnicianId, storeId }. workorderId is set when the chat was opened
  from a WO; texts sent elsewhere (no WO) are left alone.

  The note is a regular (noteType 2) note tagged with the WO's current
  status, using the portal's own status → tag map.
*/
AE.tool({
  id: 'textNotes',
  name: 'Text → WO note',
  sites: ['portal.ubreakifix.net'],
  run() {
    // The portal's status id → note tag map (from its ubif-util-store bundle).
    const STATUS_TAG = {
      1: 'initial_checkin', 2: 'need_to_order', 3: 'awaiting_item', 4: 'awaiting_device', 5: 'awaiting_diagnostics',
      6: 'awaiting_partner_approval', 7: 'awaiting_callback', 8: 'ready_for_work', 9: 'diagnostics', 10: 'work_in_progress',
      11: 'quality_check', 12: 'repair_summary', 13: 'ready_for_pickup', 14: 'sale_complete', 15: 'closed', 17: 'device_abandoned',
      22: 'request_buyout_replacement', 23: 'transferred_to_depot', 24: 'ready_for_diag', 25: 'cancelled', 26: 'send_to_depot', 27: 'shipped_by_depot',
    };
    const SEND_RE = /\/messages\/v1\/send(?:[?#]|$)/;
    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    if (page.__aethernetTextHook) return; // don't double-wrap
    page.__aethernetTextHook = true;

    async function logText(sent) {
      const woId = sent.workorderId;
      const message = String(sent.message || '').trim();
      if (!woId || !message) return;
      try {
        const [prof, woRes, cust] = await Promise.all([
          AE.profile(),
          AE.api('GET', '/api/workorder/' + woId),
          AE.api('GET', '/api/v1/workorder/' + woId + '/demographic/customer-data').catch(() => null),
        ]);
        const wo = (woRes && woRes.workorder) || AE.unwrap(woRes) || {};
        const customerName = AE.data.nameOf({ customer: (cust && cust.CustomerDatum) || {} }) || 'the customer';
        const tech = prof.name || 'A technician';
        await AE.api('POST', '/api/note', {
          noteText: tech + ' sent a text message to ' + customerName + '.\n\n' + message,
          customerId: String(sent.customerId || (cust && cust.customerId) || ''),
          workorderId: Number(woId),
          noteTag: STATUS_TAG[wo.workorderStatusId] || null,
          noteType: 2,
        });
        AE.toast('Text logged', 'Added to WO ' + woId + "'s notes.", 'ok', 4000);
      } catch (e) {
        AE.toast('Text sent, but not logged', 'Couldn\'t add the WO note: ' + (e.message || e) + ' — add it by hand.', 'err', 12000);
      }
    }

    const origFetch = page.fetch;
    page.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const isReq = typeof Request !== 'undefined' && input instanceof page.Request;
        const url = isReq ? input.url : String(input);
        const method = String((init && init.method) || (isReq && input.method) || 'GET').toUpperCase();
        if (method === 'POST' && SEND_RE.test(url)) {
          const bodyText = init && typeof init.body === 'string' ? Promise.resolve(init.body)
            : isReq ? input.clone().text() : Promise.resolve('');
          // After the portal's own request succeeds — never before, never on failure.
          Promise.all([p, bodyText]).then(([res, text]) => {
            if (!res || !res.ok) return;
            let sent = null;
            try { sent = JSON.parse(text); } catch (_) { return; }
            if (sent && String(sent.communicationType || 'SMS').toUpperCase() === 'SMS') logText(sent);
          }).catch(() => {});
        }
      } catch (_) { /* never interfere with the portal's request */ }
      return p;
    };
  },
});
