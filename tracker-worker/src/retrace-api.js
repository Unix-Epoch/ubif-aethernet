/*
  Retrace on the tracker Worker (Oct 23, 2026): the inventory movement ledger's routes. Tables inv_labels,
  inv_movements, inv_items, inv_docs, inv_cursors (migrations/2026-10-23-retrace.sql), inv_item_counts and inv_baseline
  (migrations/2026-10-24-retrace-baseline.sql), inv_ignored_labels (2026-10-24-retrace-ignored-labels.sql) and inv_labels.queued_at
  (2026-10-24-retrace-queued-at.sql, apply once, before deploying); what a movement is and how
  each source becomes one: src/retrace.js (shared with Aethernet, pure). Movements are kept forever (small rows).

  Store side (x-aethernet-key + the store's Aethernet access, same as /scan; mounted by storeApi at /v1/:store/tracker/retrace/…).
  Everything is written under the store in the URL and nothing else: a label snapshot naming another store is skipped.
    POST /retrace/pass { portalCalls, workerCalls, seconds, lookupSeconds?, browser?, by? }   a finished pass's own counts (optional; src/usage.js) → { ok }
    POST /retrace/sweep { items, labels, docs, movements, touched, cursors, need, names, nameNeed, labelTotals, countNeed, poTotal, by }   one collector pass →
         { need: [label], more, changedItems: [{ item, why: new|changed }], added, rejected, skipped, written, prunedLabels, named, unnamed, countNeed: [item], missedItems: [item] }
           items      inventory-lookup rows (Portal's envelope is { OnHandItemDetails: [rows], TotalRecords, … }; the collector sends the rows: { ItemNumber, ProductName, RetailCategory, WarehouseId, OnHandQuantity,
                      AvailableQuantity, ReservedQuantity, InTransitQuantity, SalesOnOrder, VanNickName }): per item and
                      warehouse; quantities differing from the stored ones (or a new item) come back in changedItems so
                      the browser reads that item's labels. Which items to look up is the collector's call (the lookup
                      returns Portal's whole catalog, 100 a page): the server only diffs what it's sent.
           labels     label snapshots (labelSnapshot: label details or store-products rows): diffed against the stored
                      one; a status / location / consignment change is a movement and queues the label's history.
                      A snapshot's product names its item (authoritative: label details' ProductName), except one with
                      `list` set (outstanding parts, retrace.js normalize.outstanding: PartName, descriptive).
           docs       document headers (normalize.doc shape or Portal's row + type) → inv_docs
           movements  movements the browser built with retrace.js (sweeps of transfers, counts, RMA, buyback, POs),
                      checked like the watcher's (normalize.watch), keys rebuilt here
           touched    labels a sweep saw on a document: queued for a history read
           cursors    { sweepName: value } where each sweep got to (JSON, 4000 chars max each) → GET /retrace/cursor
           need       how many labels to hand out for history reads (default NEED_MAX 60, at most NEED_CAP)
           pos        purchase orders: [{ header, receive }] (header = a list row or GET boh/purchase-orders/{po};
                      receive = …/receive-details) or bare list rows; at most 600. Kept in inv_docs (type 'po') with a status
                      history (inv_doc_events), see the PO block in the route below.
           poNeed     how many POs whose lines / receive details should be read next to hand out (default 0, at most 100)
           names      [{ item, name, authoritative?, category? }] item names the browser read (RMA lines' item_name,
                      transfer lines: descriptive; Portal's item record for an unnamed item: authoritative); at most
                      NAMES_MAX, entries without an item or a name skipped. See "item names" above.
           nameNeed   how many items with no name to hand out (default 0, at most UNNAMED_CAP)
         pos: { seen, written, events, received, need: [po] }   need: POs to read in full (new, or tracked fields moved)
         named: items whose name this sweep set or changed (any source above, the PO lines' too)
         unnamed: items with a movement or a label at the store and no name, newest first (nameNeed of them; ignored items never)
         need: labels whose serial history should be (re)read, changed > touched > backfill, claimed CLAIM_MIN minutes
         so a second browser skips them (the /scan pattern; picked and claimed in one statement).
         prunedLabels: buyback labels (B-<n>-<digits>) filed under their number as an item before that stopped (Oct 24, 2026) with nothing from
         Portal behind them (no status, product, location, PO, WO, change, history, movement), deleted; see PRUNE_BUYBACK. A buyback label's
         number is not its item: from a touch alone it is stored with no item and its history says what it is.
         The baseline (see "progress" below): labelTotals [{ item, total }] are Portal's label counts per item (the browser reads
         each lookup item's label list with pageSize=1 and takes its @odata.count), kept until the baseline freezes; countNeed
         is how many lookup items still without a count to hand out (default 0, at most COUNT_CAP; none once frozen);
         missedItems: items the coverage check (src/retrace-verify.js) found referenced at the store with no labels stored, up to 20 a
         sweep, each handed out once: the browser reads their label lists like a changed item's.
         soNeed (request: how many, default 0, at most SO_NEED_CAP 50) → [{ sales_order, label }]: sales orders the movements name with no inv_so_wo
         row, newest first, one label each (the label's newest sales order is this one) for the browser to read label details of; claimed CLAIM_MIN
         minutes. soNone (request): sales orders whose label details were read for real and carried no WorkOrderId: not handed out again for a day
         (inv_so_need, migrations/2026-10-25-retrace-so-need.sql). A sales order linked meanwhile (label snapshot with SalesOrderNumber + WorkOrderId) leaves the list.
         shortItems: once the baseline is frozen, baseline items with fewer labels stored than Portal's count (shortNeed: how many, default 0,
         at most SHORT_CAP, biggest gap first): the browser reads their label lists (and remembers which it tried, a list can stay short).
         poTotal is the number of purchase orders (in transit + past) Portal lists, taken once. A lookup cursor with rows 0 is not
         recorded (an empty lookup is a failed one, not "every item counted").
    POST /retrace/history { label, rows, by }   the label's serial-history rows (boh/serial-history/{label}: the rows,
         or Portal's { value: [rows] } as is) → { ok, added, same, skipped } · rows normalized here (normalize.historyRows),
         duplicates ignored, rows naming another store or label skipped, the label leaves the queue (unless a sweep or movement queued it
         again after the read was handed out: queued_at; then it stays, unclaimed). A label whose CURRENT item (the newest row's ItemId) is
         BB0001 comes back as { ok, added: 0, ignored: true, deletedLabels: 0 | 1, skipped }: the label and its movements are deleted and it
         is remembered (inv_ignored_labels), so touched / snapshot / movement / PO mentions of it never queue or store it again.
         Settling the baseline after a read is throttled (settleAfterHistory).
    POST /retrace/watch { movements, by }   up to WATCH_MAX movements the in-page watcher saw Portal write → { ok, added, rejected }
    GET  /retrace/cursor                   → { cursors: { sweepName: { value, at } }, baseline: { frozen, posKnown } }
    GET  /retrace/progress?seen=<done_at>  → { store, state: 'counting'|'gathering'|'done', pct, done_at, announce }   the client's read-only
         signal for a future manager popup (same key + store access as the rest). pct: 0–100 once the baseline is frozen, null
         while counting (Portal's totals aren't all in yet). done_at: when the store's initial gathering completed (the
         baseline's backfill_done_at), null before. announce: done_at is set and isn't the `seen` the client sent, i.e. show the
         popup. The client keeps the done_at it last announced (browser storage, per store) and sends it as `seen`; nothing is
         stored on the server for it, so every browser at the store announces once. If a popup must show once per store across
         browsers, add an announced_at column and an ack route then (not needed yet).
  Progress (src/retrace-api.js progress / settle; the admin page's strip and the popup signal): the gathering is measured against a
  baseline that is set early and then frozen, so the denominators don't move while the browser discovers things:
    counting    the browser asks Portal each lookup item's label count (one call per item, pageSize=1, location All = sold included)
                and the PO list counts; nothing is shown as a percentage yet.
    gathering   all items counted (and PO count known): expected_labels = the sum of the counts, expected_items = items counted,
                expected_pos = in-transit + past POs. Frozen then (counted_at), and never empty: at least one lookup item counted, and
                labels counted when labels are already known (a lookup that came back with no rows, or counts of 0 for every item,
                keeps it counting). A frozen row with expected_items = 0 is not a baseline (the Oct 24 store 914 bug: a lookup of 0 rows
                counted as "every item counted"): the next sweep clears it (counts, counted_at, expected_*, and its backfill_done_at,
                which can't be true) and counts again. Steps, each X of Y against that baseline:
                  stock lookup  items counted of expected_items · labels found  labels stored for the baseline's items (per item at most its count)
                  histories read  of those labels, serial history read · purchase orders  read in full (not drafts) of expected_pos
                  item names  baseline items with a name of expected_items
                Labels that show up later (new POs, new items) are "new since": they never change the baseline.
    done        every step at 100%, the PO list read through and no more histories queued than a few new labels explain (QUEUE_SLACK):
                backfill_done_at is set once and never cleared or moved (but for the empty baseline above). Ordinary
                later changes (new labels, a PO to read) don't un-done it. There is no re-count route. By hand: deleting a store's
                inv_item_counts rows and clearing counted_at / expected_* in its inv_baseline row makes it count again and freeze a
                new baseline; backfill_done_at stays, so the signal doesn't fire a second time (state stays 'done', pct follows the
                new baseline). To announce again on purpose: set backfill_done_at to NULL.
    pct is weighted by the work each unit costs (PROGRESS_WEIGHT); eta_min = the longest step at its per-pass rate (PER_PASS) × 10 minutes,
    which only passes while a store browser has Portal open with Aethernet on.
  WO hook: woRetraceStmts() (retrace-core.js), called by POST /v1/:store/tracker/wo/:wo into the same batch as status / RFP periods.

  Admin side: retraceAdmin() (retrace-admin.js), mounted by trackerRoutes at /api/tracker/retrace/… (page 'retrace'; route list there).
*/
// The code lives in three modules; this one keeps the reference above and the names index.js and the tests import.
export * from './retrace-core.js';
export * from './retrace-ingest.js';
export * from './retrace-admin.js';
