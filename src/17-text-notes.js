/*
  Recitation (text → WO note). When a text is sent to a customer from inside a work
  order, post it as a note on that WO:

    Garrett Green sent a text message to Tina Liddy.

    <the message>

  How (v2.3.2): the browser's own network log (PerformanceObserver) reports
  every request the page makes, however Portal's code issues it. When a
  POST …/messages/v1/send shows up while a WO page is open (core's
  text-sent event, shared with Auto-Waymark since 2.17), read that WO
  customer's message history (GET /api/messages/v1/customers/{id}, the same
  call the chat panel makes right after sending) and log each of *your*
  outbound messages from the last few minutes that isn't logged yet. Finding
  it in the history also confirms it actually went out. Never sends texts.

  Why not wrap fetch (v2.3.0/2.3.1): Portal's messaging code keeps its
  own reference to fetch from load time, before any userscript runs, so a
  wrapper never saw the send (confirmed on Zen with a HAR, Sep 26 2026).

  The note is a regular (noteType 2) note tagged with the WO's current
  status, using Portal's own status → tag map. Afterwards the WO view is
  refreshed in place (AE.refreshView), so the note shows without a reload.
*/
AE.crystal({
  id: 'textNotes',
  name: 'Recitation',
  sites: ['portal.ubreakifix.net'],
  run() {
    // Portal's status id → note tag map (from its ubif-util-store bundle).
    const STATUS_TAG = {
      1: 'initial_checkin', 2: 'need_to_order', 3: 'awaiting_item', 4: 'awaiting_device', 5: 'awaiting_diagnostics',
      6: 'awaiting_partner_approval', 7: 'awaiting_callback', 8: 'ready_for_work', 9: 'diagnostics', 10: 'work_in_progress',
      11: 'quality_check', 12: 'repair_summary', 13: 'ready_for_pickup', 14: 'sale_complete', 15: 'closed', 17: 'device_abandoned',
      22: 'request_buyout_replacement', 23: 'transferred_to_depot', 24: 'ready_for_diag', 25: 'cancelled', 26: 'send_to_depot', 27: 'shipped_by_depot',
    };
    const WINDOW_MS = 3 * 60 * 1000;        // how recent a sent message must be
    const LOGGED_KEY = 'ae_text_notes_logged'; // messageId → time logged (shared across tabs)
    const loadLogged = () => {
      const all = GM_getValue(LOGGED_KEY, {}), cutoff = Date.now() - 2 * 86400000;
      for (const [k, t] of Object.entries(all)) if (t < cutoff) delete all[k];
      return all;
    };
    let busy = null;

    async function logRecentTexts(woId) {
      if (AE.status.blocked('textNotes')) return; // paused: the text went out, but no note is added
      const [prof, woRes, cust] = await Promise.all([
        AE.profile(),
        AE.api('GET', '/api/workorder/' + woId),
        AE.api('GET', '/api/v1/workorder/' + woId + '/demographic/customer-data'),
      ]);
      const wo = (woRes && woRes.workorder) || AE.unwrap(woRes) || {};
      const customerId = cust && cust.customerId;
      if (!customerId) return 0;
      const hist = await AE.api('GET', '/api/messages/v1/customers/' + customerId + '?page=1&pageSize=10&sortOrder=DESC&storeId=' + (prof.storeId || ''));
      const logged = loadLogged();
      const fresh = ((hist && hist.messages) || []).filter((m) =>
        String(m.direction).toUpperCase() === 'OUTBOUND' &&
        String(m.senderId) === String(prof.userId) &&
        Date.now() - Date.parse(m.contactDate) < WINDOW_MS &&
        !logged[m.messageId]);
      const tech = prof.name || 'A technician';
      for (const m of fresh.reverse()) { // oldest first
        const to = AE.data.nameOf({ customer: { fullName: m.customerName } }) ||
          AE.data.nameOf({ customer: (cust && cust.CustomerDatum) || {} }) || 'the customer';
        await AE.api('POST', '/api/note', {
          noteText: tech + ' sent a text message to ' + to + '.\n\n' + String(m.content || '').trim(),
          customerId: String(customerId),
          workorderId: Number(woId),
          noteTag: STATUS_TAG[wo.workorderStatusId] || null,
          noteType: 2,
        });
        logged[m.messageId] = Date.now();
        GM_setValue(LOGGED_KEY, logged);
        AE.track('textNotes:note');
      }
      return fresh.length;
    }

    async function onSend() {
      const m = location.pathname.match(/^\/repair\/workorder\/(\d+)/);
      if (!m) return; // texts sent outside a WO aren't logged
      if (busy) return busy; // several sends in a burst → one lookup
      busy = (async () => {
        await AE.sleep(1200); // let Portal's own write land first
        try {
          let n = await logRecentTexts(m[1]);
          if (!n) { await AE.sleep(2500); n = await logRecentTexts(m[1]); } // history can lag a moment
          if (n) { AE.refreshView(); AE.emit('wo-changed', { woId: m[1], why: 'note' }); } // Assize re-reads the order's notes
          if (n) AE.toast('Text logged', (n > 1 ? n + ' texts' : 'Text') + ' added to WO ' + m[1] + "'s notes.", 'ok', 4000);
        } catch (e) {
          AE.toast('Text sent, but not logged', { html: "Couldn't add this text to the WO notes. " +
            AE.bugLink('Report a bug.', { where: 'Recitation', error: 'Adding the text note to WO ' + m[1] + ' failed: ' + (e.message || e) }) }, 'err', 12000);
        } finally { busy = null; }
      })();
      return busy;
    }

    AE.on('text-sent', () => onSend());
    AE.textNotesDebug = { onSend, logRecentTexts }; // for testing
  },
});
