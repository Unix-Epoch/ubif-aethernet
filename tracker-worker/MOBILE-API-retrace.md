# Linkpearl phone API: Retrace lookup (`/v1/agents/m/retrace…`)

Server side of the Retrace tab (find an item or a label, see where it stands and what happened to it, list purchase orders). Implemented in `src/mobile-retrace.js`, tests in `test/mobile-retrace.test.mjs` (the examples below are real output from those tests, invented data). Read `MOBILE-API.md` first: base URL, headers (`x-aethernet-key`, `Authorization: Bearer <id>.<token>`), registration, error shape `{"error":"…"}`. All answers are JSON, `cache-control: no-store`, GET only (any other method is `404`). Times are ISO UTC (`…Z`); format them in the store's zone.

## Rules for every route

- **One store per request.** `store=<id>` (query, or the path segment) is required and must be one of the phone's approved stores. Missing or not a number (including `all`) is `400 {"error":"store: a store number"}`; a store the phone is not approved for is `403 {"error":"not your store"}`. A Mac audit agent gets `403 not a phone`, a pending phone `403 not approved yet`, a revoked or unknown one `401`.
- **Plain data only, no sealed blobs, nothing logged** (no `access_log` rows). The data is inventory (item numbers, labels, purchase orders), not customer data.
- **No people, no device identifiers.** No staff name anywhere (the tracker's movement `user_name`, the spot-check's `checked_by` and similar are never read), and the customer-device IMEI and OEM serial the tracker stores on a label are never returned. Movements carry no free text: only `kind`, `refType`, `refId`, `label` and the time. A PO's own label list and lines are not returned (only counts).
- Where a label **stands now** is computed the same way as on the admin site (`src/retrace-now.js`): from Portal's own status on the label and its latest status-bearing movement. See "Now: texts and groups".
- Everything is "as of" the tracker's last read of Portal, not live. `items` has `asOf`.
- Pagination (`items`, `pos`): `limit` (default 25, max 100; anything unparsable is the default) and `after=<cursor>` where the cursor is the opaque `next` of the previous page (base64url JSON; pass it back unchanged, with the same `q`; anything else is `400 after: not a cursor from this list`). `next` is null on the last page. Rows may change between pages; refresh from the top when it matters.

## `GET /v1/agents/m/retrace/items?store=<id>[&q=<text>][&after=<cursor>][&limit=<n>]`

Items that have at least one movement at the store, **most recent movement first** (then item number). An item the tracker has never seen move is not listed.

- `q` (optional; trimmed, control characters removed, at most 60 characters): matches the **item number by its start** (`1762` finds `176255`) **or the item's name containing the text**, any case. `%` and `_` are literal. Names are the ones Retrace holds from Portal's stock lookup; an item with movements but no stock-lookup row has no name to search (it is found by number; its row's `name` then falls back to the product name on one of its labels).
- **Label jump**: if `q` looks like a label (`<item>-<digits>`, e.g. `176255-0000514371`, or a buyback `B-<item>-<digits>`; a start such as `176255-00005` counts) and this is the first page (no `after`), the answer also has `labels`: up to 10 labels of this store that equal it or start with it, exact match first, then by label; each `{ label, item, name, now, group }`. Open one with the label route. `labels` is **absent** when `q` is not label-shaped (and on later pages) and `[]` when it is but nothing matches. `items` is searched as usual (normally empty for a label).
- Row fields: `item` (item number, text), `name` (null if unknown), `category` (null if unknown), `onHand` (sum of `onHand` over all of Portal's warehouses, from the last stock lookup; **null** when the item has no stock-lookup quantity), `available` (sum of `available` over the warehouses that are not quarantine (id ending in `Q`), the admin site's Available tile; **with no stock-lookup quantity it is the number of the item's labels that stand "Available" now, or null for an item with no labels**), `lastAt` (time of the item's most recent movement).
- `asOf`: when the store's last sweep of Portal finished; null if none recorded. Show it as "as of".

```
GET /v1/agents/m/retrace/items?store=914&limit=2
{
  "v": 1,
  "now": "2026-11-14T01:06:04.408Z",
  "store": 914,
  "q": null,
  "asOf": "2026-11-14T00:36:03.192Z",
  "items": [
    {
      "item": "176255",
      "name": "Galaxy S23 screen",
      "category": "Screens",
      "available": 3,
      "onHand": 6,
      "lastAt": "2026-11-14T00:06:03.186Z"
    },
    {
      "item": "180001",
      "name": "Battery pack",
      "category": "Batteries",
      "available": 122,
      "onHand": null,
      "lastAt": "2026-11-13T22:06:03.188Z"
    }
  ],
  "next": "eyJhdCI6IjIwMjYtMTEtMTNUMjI6MDY6MDMuMTg4WiIsIml0ZW0iOiIxODAwMDEiLCJ0IjoiIn0"
}
```

```
GET /v1/agents/m/retrace/items?store=914&q=176255-0000514371       (label jump)
{
  "v": 1,
  "now": "2026-11-14T01:06:04.418Z",
  "store": 914,
  "q": "176255-0000514371",
  "asOf": "2026-11-14T00:36:03.192Z",
  "items": [],
  "next": null,
  "labels": [
    {
      "label": "176255-0000514371",
      "item": "176255",
      "name": "Galaxy S23 screen",
      "now": "Sold",
      "group": "out"
    }
  ]
}
```

Errors: `400 store: a store number`, `400 after: not a cursor from this list` (also a cursor made for a different `q`), `403 not your store`.

## `GET /v1/agents/m/retrace/item/<store>/<item>[?group=in|wo|out|q|bad]`

One item: its facts, how its labels stand now, its labels and its latest movements. `<item>` is the item number (URL-encoded, at most 40 characters).

- `info`: `name`, `category` (null when the tracker has no stock-lookup row; the name may then come from a label's product), `onHand`, `available` (same meaning as in the items list), `lastSeen` (when the stock lookup last saw the item; null if never).
- `counts`: `[{ now, group, n }]`, **every label of the item** grouped by where it stands now, biggest first (ties by `now`). The `n` add up to the number of labels.
- `labels`: the item's labels, **at most 100**, most recent movement first (labels with no movement last, then by label). `group=` keeps only labels in that group (an unknown group is `400 group: in, wo, out, q, bad`). `labelsTotal` is how many labels match (in that group, if filtered): when it is more than 100 the rest cannot be listed, so filter by group or open them by label. Per label: `label`; `now` and `group`; `wo` (work order number the label is tied to, text; null if none: for a Reserved label the work order it is reserved for, for a Sold one the one it was sold on); `po` (purchase order it arrived on, null if none); `lastKind` and `lastAt` (its newest movement of any kind; both null when it has none). At most 1000 labels of an item are read.
- `movements`: the item's newest movements, **at most 50**, newest first, over every label of the item and also item-level ones (`label` null: a quantity-only part used on a work order). Each `{ at, kind, refType, refId, label }` (see "Movements").
- `404 {"error":"item not seen at this store"}` when the tracker holds no item row, label or movement for it at that store. A known item with nothing yet is `200` with empty `labels`, `movements` and `counts`, `labelsTotal: 0`. A malformed item is `400`.

```
GET /v1/agents/m/retrace/item/914/176255      (labels and movements cut to three each here)
{
  "v": 1,
  "now": "2026-11-14T01:06:04.435Z",
  "store": 914,
  "item": "176255",
  "info": {
    "name": "Galaxy S23 screen",
    "category": "Screens",
    "onHand": 6,
    "available": 3,
    "lastSeen": "2026-11-13T23:06:03.168Z"
  },
  "counts": [
    {
      "now": "Available",
      "group": "in",
      "n": 2
    },
    {
      "now": "Quarantined",
      "group": "q",
      "n": 1
    },
    {
      "now": "Reserved",
      "group": "wo",
      "n": 1
    },
    {
      "now": "Sold",
      "group": "out",
      "n": 1
    }
  ],
  "labels": [
    {
      "label": "176255-0000514372",
      "now": "Available",
      "group": "in",
      "wo": null,
      "po": "UBFPO000000001",
      "lastKind": "received",
      "lastAt": "2026-11-14T00:06:03.186Z"
    },
    {
      "label": "176255-0000514374",
      "now": "Quarantined",
      "group": "q",
      "wo": null,
      "po": null,
      "lastKind": "defective",
      "lastAt": "2026-11-13T05:06:03.187Z"
    },
    {
      "label": "176255-0000514373",
      "now": "Reserved",
      "group": "wo",
      "wo": "7000002",
      "po": null,
      "lastKind": "reserved",
      "lastAt": "2026-11-12T19:06:03.187Z"
    }
  ],
  "labelsTotal": 5,
  "movements": [
    {
      "at": "2026-11-14T00:06:03.186Z",
      "kind": "received",
      "refType": "po",
      "refId": "UBFPO000000001",
      "label": "176255-0000514372"
    },
    {
      "at": "2026-11-13T16:06:04.203Z",
      "kind": "received",
      "refType": null,
      "refId": null,
      "label": "176255-0000777777"
    },
    {
      "at": "2026-11-13T15:06:03.190Z",
      "kind": "used",
      "refType": "wo",
      "refId": "7000002",
      "label": null
    }
  ]
}
```

## `GET /v1/agents/m/retrace/label/<store>/<label>`

One label: what it is, where it stands and its movement timeline. `<label>` is the label text (URL-encoded), e.g. `176255-0000514371`; text that cannot be a label is `400 not a label`.

- `row`: `{ label, item, name, now, group, wo, po, salesOrder }`; `item`, `name`, `wo`, `po` and `salesOrder` (the `FSO…` sales order) are null when unknown. `row` is **null** when the tracker has movements for the label but no label row (rare); then there is no `now`, show the timeline only.
- `movements`: the timeline **oldest to newest**, **at most the newest 300**; `movementsTotal` is the full count (when it is more than 300 the oldest ones are not returned). Each `{ at, kind, refType, refId, label }`.
- `404 {"error":"label not seen at this store"}` when there is neither a label row nor a movement. Labels are per store: a label of another store is `404` here too.

```
GET /v1/agents/m/retrace/label/914/176255-0000514371
{
  "v": 1,
  "now": "2026-11-14T01:06:04.444Z",
  "store": 914,
  "label": "176255-0000514371",
  "row": {
    "label": "176255-0000514371",
    "item": "176255",
    "name": "Galaxy S23 screen",
    "now": "Sold",
    "group": "out",
    "wo": "7000010",
    "po": "UBFPO000000001",
    "salesOrder": "FSO000011111"
  },
  "movements": [
    {
      "at": "2026-10-28T09:06:03.182Z",
      "kind": "received",
      "refType": "po",
      "refId": "UBFPO000000001",
      "label": "176255-0000514371"
    },
    {
      "at": "2026-11-05T17:06:03.183Z",
      "kind": "reserved",
      "refType": "sales_order",
      "refId": "FSO000011111",
      "label": "176255-0000514371"
    },
    {
      "at": "2026-11-09T21:06:03.184Z",
      "kind": "sold",
      "refType": "sales_order",
      "refId": "FSO000011111",
      "label": "176255-0000514371"
    }
  ],
  "movementsTotal": 3
}
```

## `GET /v1/agents/m/retrace/pos?store=<id>[&after=<cursor>][&limit=<n>]`

Purchase orders of the store, **newest document date first** (equal dates: higher PO number first; a PO with no date comes last).

- `po` (PO number, e.g. `UBFPO000000003`), `status` (Portal's status text **exactly as stored**: free text, at most 40 characters, null if none), `counterpart` (as stored: the vendor text Portal gave; null if none), `date` (the PO's document date, ISO UTC; null if none), `labels`, `received`, `total`.
- `labels`: how many labels the tracker has for the PO (from the PO's receive details), **null when it has not read them yet** (0 = read, none listed). `received`: how many of those labels have receive status `Received` (case-insensitive); null exactly when `labels` is null. "x of y received" is `received` of `labels`. These are the admin site's PO list numbers.
- `total`: the PO's total **amount in dollars** (Portal's `UbifTotalAmount`), not a quantity; null when unknown. (The admin site shows it as money too.)
- **Status values**: the tracker keeps whatever Portal sends, so the set is open. Seen in captures and tests: `Backorder`, `Received`. The admin site also treats (case-insensitively) `Invoiced` like Received, `Draft` as a draft, and anything containing `cancel` as cancelled; everything else is shown as the text it is. Display `status` as given and style only the few you know; never assume a closed list.

```
GET /v1/agents/m/retrace/pos?store=914&limit=3
{
  "v": 1,
  "now": "2026-11-14T01:06:04.450Z",
  "store": 914,
  "pos": [
    {
      "po": "UBFPO000000003",
      "status": "Backorder",
      "counterpart": "Vendor A",
      "date": "2026-11-13T01:06:03.460Z",
      "labels": 0,
      "received": 0,
      "total": 120
    },
    {
      "po": "UBFPO000000002",
      "status": "Received",
      "counterpart": "Vendor B",
      "date": "2026-11-11T01:06:03.460Z",
      "labels": 3,
      "received": 2,
      "total": 4
    },
    {
      "po": "UBFPO000000001",
      "status": "Draft",
      "counterpart": "Vendor B",
      "date": "2026-11-11T01:06:03.460Z",
      "labels": 0,
      "received": 0,
      "total": null
    }
  ],
  "next": "eyJhdCI6IjIwMjYtMTEtMTFUMDE6MDY6MDMuNDYwWiIsImlkIjoiVUJGUE8wMDAwMDAwMDEifQ"
}
```

## Now: texts and groups

`now` is a short text and `group` a code for where a label stands today. `group` is one of `in`, `wo`, `out`, `q`, `bad`, or **null** (a status Retrace does not map: `now` is then Portal's own status word, or `Unknown`).

| `group` | meaning | `now` texts |
|---|---|---|
| `in` | in stock | `Available`, `In transit` |
| `wo` | reserved for a work order | `Reserved` |
| `out` | gone from stock | `Sold`, `Used on repair`, `Transferred out`, `On a van`, `Adjusted out` |
| `q` | quarantined, defective or returned | `Defective`, `Quarantined`, `Salvage`, `RMA`, `Buyback` |
| `bad` | lost | `Lost`, `Missing` |
| null | not mapped | Portal's raw status text, or `Unknown` |

A label in Portal's quarantine warehouse is `Quarantined` / `q` whatever else it is (unless Sold or Lost). Use `group` for colours and filters and `now` for the text.

## Movements

`{ at, kind, refType, refId, label }`:

- `kind` is one of: `shipped_to_store`, `received`, `reserved`, `unreserved`, `used`, `sold`, `returned`, `swapped_in`, `swapped_out`, `transfer_out`, `transfer_in`, `van_out`, `van_in`, `adjusted_in`, `adjusted_out`, `count_found`, `count_missing`, `quarantined`, `defective`, `lost`, `rma`, `buyback`, `salvage`, `consignment_changed`, `status_changed`. `status_changed` is a Portal event Retrace could not classify yet; `consignment_changed` is a consigned label turning owned (neither changes where a label stands). Show an unknown future value as plain text.
- `refType` / `refId`: the document behind the movement; both null when there is none. `refType` is `po`, `sales_order` (an `FSO…` number), `wo` (a work order number), `journal`, `reason` (`refId` is a reason text such as `Defective part(s)`), `transfer`, `rma`, `buyback`, `count`, `arrival`, `van`, or, for a Portal document type Retrace does not know, Portal's own table name lowercased. Treat it as open text.
- `label` is null for an item-level movement (no serial).

## Limits at a glance

page 25 (max 100) · `q` 60 characters · label jump 10 labels · item: 100 labels (1000 read), 50 movements · label: 300 movements · no movement filters, date ranges, user filter, or search by IMEI / OEM serial / work order (the admin site has them; this API deliberately does not).

## Performance

Indexes used, no migration: items `inv_mv_item (store, item, at)` (per-item `MAX(at)` from the index alone), `inv_items` PK and `inv_labels_item (store, item)` for `q`; item `inv_mv_item`, `inv_labels_item`, and `inv_mv_label (store, label, at)` for each label's newest movement; label `inv_labels` PK and `inv_mv_label`; pos `inv_docs` PK `(store, type, id)` (keys ordered first, then only the page's JSON is read). The items list is the one query that grows with the store's movement count (one pass over the store's movement index entries); it is the same aggregate the admin site runs on every page open.
