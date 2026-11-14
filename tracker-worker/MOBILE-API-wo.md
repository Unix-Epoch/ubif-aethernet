# Linkpearl phone API: work order lookup (`/v1/agents/m/wo…`)

Server side of the Work orders tab (list, search, detail, unlock). Implemented in `src/mobile-wo.js`, tests in `test/mobile-wo.test.mjs` (the examples below are real output from those tests, invented data). Read `MOBILE-API.md` first: it defines the base URL, the headers (`x-aethernet-key`, `Authorization: Bearer <id>.<token>`), registration, the wrapped store keys and the error shape `{"error":"…"}`. All answers are JSON, `cache-control: no-store`, GET only (any other method is `404`).

## Who may call what

- The caller is an approved phone; `device.stores` are its approved stores. Every route is limited to them. A store outside them is `403 {"error":"not your store"}` (never silently dropped from `all`); a malformed store is `400`; an unknown work order is `404 {"error":"no such work order"}`.
- Sealed blobs (the card, the snapshot) are only sent for a store the phone holds a wrapped key for (`keys` in `/me`). Without one: `cards=1` skips that store's cards (see below), `sealed=1` is `403 {"error":"no key for this store"}`.
- Every send of sealed data is written to the tracker's `access_log` (what the admin site's access log page shows) with the phone as the actor: `cards=1` writes one row per store (action `list`, detail `phone cards <n> <first 8 of device id>`), `sealed=1` writes one row (action `open`, store, wo, detail `phone sealed <8 hex>`), actor `device:<phone name>`. The row is written before the blob is returned. Plain reads (list without cards, find, plain detail) are not logged. Rows are pruned after 400 days like all log rows.
- No customer or staff name, phone, email or IMEI is ever in a plain response. (Staff names exist in plain only inside the stored `auditTrail.createdBy`, `workorder.createdBy / updatedBy` and `partEvents`; this API never reads them. The detail's `changes` come from a whitelist of two fields, so a change row about `createdBy` / `updatedBy` or the audit trail can never be returned; Waymark's `by_name` / `by_id` and the history log are never read; the parts rows carry no user.)
- A Mac audit agent gets `403 {"error":"not a phone"}`, a pending phone `403 not approved yet`, a revoked or unknown one `401`.

## What the tracker stores in plain, against what the mockups want

Row fields (list, find and the detail header all use the same row):

| Field | Source | Notes |
|---|---|---|
| `store`, `wo` | workorders PK | ints |
| `open` | `is_open` | bool |
| `statusId`, `status` | `status_id`, `status_name` | `status` is Portal's name when the tracker saw it (null on a legacy row with no detail yet) |
| `lane` | same mapping as Home (`mobile.js` `laneOf`) | `order` = 2, `start` = 8, 24, `work` = 9-12, `wait` = 3, 4, 7 and any other open status, `rfp` = 13; `null` for a closed work order |
| `device` | `device` | model only |
| `program` | `program_name` | e.g. Retail |
| `bin` | `plain.workorder.bin` | bin name, null if none or unknown |
| `outcome` | `service_outcome` | Completed / Incomplete / Declined / No issue found / null |
| `cartValue`, `cartDue` | `cart_value` (before tax, partner credit ignored), `cart_due` | dollars, null if no cart seen. Portal empties a cart at Sale complete, so both are usually null or 0 on a closed work order |
| `lastCartValue` | `last_cart_value` | dollars before tax, partner credit ignored: the last **non-empty** cart the tracker saw (the figure to show on a sold or closed work order). null if it never saw a cart with lines. Also set on open work orders that have a cart |
| `statusSince` | `status_periods` open interval, only if it is the current status | ISO UTC, **null = unknown** (never `updatedAt`); always null for closed |
| `createdAt`, `updatedAt`, `closedAt` | `created_at`, `api_updated_at` (Portal's own updatedAt), `closed_at` | ISO UTC or null. `closedAt` is when the tracker recorded the close |
| `closedReason` | `closed_reason` | the status name the work order closed with: `Sale complete`, `Closed` or `Cancelled`; null while open (and on a legacy row) |
| `tags`, `followUp` | Waymark (see below) | **only on rows of the open list (`state=open`) and on the detail's `wo`**; absent on `recent` / `closed` rows and on `find` rows |
| `notes` | `plain.notes.total` | note count, null when no plain part is stored yet |

Detail adds: `nextUpdate`, `slaEnd`, `rfpAt`, `outcomeReason`, `soldAt` (all ISO or null; `soldAt` = when it reached Sale complete), the timeline, the cart, `parts` and `changes`. For a closed work order the detail's `wo` therefore has `closedAt`, `closedReason`, `soldAt`, `outcome`, `lastCartValue` (each null when unknown).

**The mockups want but the tracker does not store in plain (so they are not in any response):**
- the customer name shown on every card (sealed in the card; the app shows it after unlocking, from the card it already holds);
- the issue / repair summary ("Screen", "Battery"): not in the plain part. The cart lines are the closest plain thing (detail only, `cart.lines[].name`), but which line is "the repair" is a guess the server does not make; the full text is in the sealed snapshot (the check-in note and the workorder). A reasonable app rule after unlocking: show the first cart line name, or the sealed intake note;
- the "Urgent" flag / attention state: not stored anywhere (Assize runs in the browser and its alerts live in the alerts stream, not on the work order). Not available here;
- `Sandbox #999999` style store labels: use the store id and Home's `stores[].name`.

## `GET /v1/agents/m/wo`: the list

Query: `store=<id>|all` (default `all` = the phone's approved stores), `state=open|recent|closed` (default `open`), `lane=order,start,work,wait,rfp` (open only; comma list), `followups=1` (open only; see Waymark), `sort=status|updated|closed` (default `status`: longest in status first; `updated`: newest Portal update first; `closed`: newest close first, `recent` and `closed` only, and the default there; `state=closed` accepts no other sort), `limit` (default 25, max 100; anything unparsable is the default), `after=<cursor>`, `closedDays=1..14` (`recent` only, default 7, clamped), `cards=1`.

- `open`: `is_open = 1`. `recent`: closed (`is_open = 0`) with `closed_at` within `closedDays` days. **`closed` (new, Linkpearl 1.1): every closed work order of the scope, newest `closedAt` first, then store, then number, paged with `after` all the way back to the oldest the tracker holds** (no `closedDays`, no cap; the response has no `closedDays` and no `lanes`). A closed work order with no recorded close time is not listed. An old app that only knows `recent` keeps working unchanged: `state=recent` and its default sort, 7/14-day window, cursor and page shape are exactly as before, plus the additive row fields `lastCartValue` and `closedReason`.
- **Retention window for `recent` (unchanged; use `closed` to go further back)**: default **7 days, at most 14**. The tracker keeps every work order row forever (only older snapshots and change rows are archived after 183 days, and a work order's latest snapshot is always kept), so storage is not the limit; 14 is the same maximum the Mac audit's `/v1/agents/wos?closedDays=` uses, and a week matches the time people still ask about a finished repair. Older closed work orders are reachable by number through `/find`, or page back through `state=closed`.
- Sort is stable and keyset-paged: the cursor (`next`) is opaque (base64url JSON of the last row's sort key, store and number); pass it back unchanged with the same `state` and `sort`, otherwise `400`. `next` is null on the last page. Rows with unknown time in status sort after those with a known one (then by store, number). Rows can change between pages (a status moves): a row may then appear on neither or both pages; refresh from the top when it matters.
- `lanes` (first page of an `open` list only, i.e. when `after` is absent): counts of all open work orders in scope, **not narrowed by `lane`**, the same numbers as Home's `lanes`. Use it for the filter chips.
- A `closed` page reads at most `limit + 1` index entries per store (`wo_closed (store, is_open, closed_at)`), so page cost does not grow with the number of closed work orders. Cursors: a `closed` cursor only works with `state=closed`.
- `cards=1` adds `card` to each row (see "Sealed data"); top-level `cards: true`, `cardsFor: [stores with cards]`, `noKey: [stores the phone has no key for]`. A row's `card` is null when the work order has no card yet or its store is in `noKey`. `cards=1&store=<id>` for a keyless store is `403 no key for this store`.
- Size: about 330 bytes a row without cards (25 rows ≈ 8 KB); with cards add roughly 0.5 KB a row (100 rows ≈ 60 KB). Page with `cards=1` only after unlocking.

```
GET /v1/agents/m/wo?store=914&limit=3&lane=order,work,rfp
{
  "v": 1,
  "now": "2026-11-14T01:03:36.589Z",
  "state": "open",
  "sort": "status",
  "scope": 914,
  "stores": [
    914
  ],
  "rows": [
    {
      "store": 914,
      "wo": 7000001,
      "open": true,
      "statusId": 2,
      "status": "Need to order",
      "lane": "order",
      "device": "Galaxy S23 Ultra",
      "program": "Retail",
      "bin": null,
      "outcome": null,
      "cartValue": null,
      "cartDue": null,
      "lastCartValue": 199,
      "statusSince": "2026-11-09T01:03:35.373Z",
      "createdAt": "2026-11-05T17:03:34.053Z",
      "updatedAt": "2026-11-14T00:03:34.053Z",
      "closedAt": null,
      "closedReason": null,
      "notes": 3,
      "tags": [
        {
          "tag": "Priority",
          "color": "#d9534f"
        },
        {
          "tag": "Waiting on customer",
          "color": "#f0ad4e"
        },
        {
          "tag": "One-off",
          "color": null
        }
      ],
      "followUp": {
        "kind": "callback",
        "due": "2026-11-14"
      }
    },
    {
      "store": 914,
      "wo": 7000003,
      "open": true,
      "statusId": 13,
      "status": "Ready for pickup",
      "lane": "rfp",
      "device": "Galaxy S23 Ultra",
      "program": "Retail",
      "bin": null,
      "outcome": null,
      "cartValue": 149,
      "cartDue": 149,
      "lastCartValue": 149,
      "statusSince": "2026-11-13T01:03:34.149Z",
      "createdAt": "2026-11-05T17:03:34.053Z",
      "updatedAt": "2026-11-14T00:03:34.053Z",
      "closedAt": null,
      "closedReason": null,
      "notes": 1,
      "tags": [],
      "followUp": {
        "kind": "rfp",
        "due": "2026-11-12"
      }
    },
    {
      "store": 914,
      "wo": 1,
      "open": true,
      "statusId": 2,
      "status": null,
      "lane": "order",
      "device": "iPhone 13",
      "program": "Retail",
      "bin": null,
      "outcome": null,
      "cartValue": null,
      "cartDue": null,
      "lastCartValue": null,
      "statusSince": null,
      "createdAt": "2026-10-01T14:00:00.000Z",
      "updatedAt": null,
      "closedAt": null,
      "closedReason": null,
      "notes": null,
      "tags": [],
      "followUp": null
    }
  ],
  "next": "eyJzIjoic3RhdHVzIiwidCI6Im9wZW4iLCJlIjoifiIsInN0Ijo5MTQsInciOjF9",
  "lanes": {
    "order": 3,
    "start": 2,
    "work": 2,
    "wait": 2,
    "rfp": 2,
    "total": 11
  },
  "followUps": {
    "count": 3,
    "today": "2026-11-13"
  }
}
```

```
GET /v1/agents/m/wo?store=914&state=recent&closedDays=14&limit=2
{
  "v": 1,
  "now": "2026-11-14T01:03:36.623Z",
  "state": "recent",
  "sort": "closed",
  "scope": 914,
  "stores": [
    914
  ],
  "rows": [
    {
      "store": 914,
      "wo": 7000010,
      "open": false,
      "statusId": 14,
      "status": "Sale complete",
      "lane": null,
      "device": "Galaxy S23 Ultra",
      "program": "Retail",
      "bin": null,
      "outcome": null,
      "cartValue": null,
      "cartDue": null,
      "lastCartValue": 149,
      "statusSince": null,
      "createdAt": "2026-11-05T17:03:34.053Z",
      "updatedAt": "2026-11-14T00:03:34.053Z",
      "closedAt": "2026-11-11T01:03:34.342Z",
      "closedReason": "Sale complete",
      "notes": 0
    },
    {
      "store": 914,
      "wo": 7000011,
      "open": false,
      "statusId": 15,
      "status": "Closed",
      "lane": null,
      "device": "Galaxy S23 Ultra",
      "program": "Retail",
      "bin": null,
      "outcome": null,
      "cartValue": null,
      "cartDue": null,
      "lastCartValue": null,
      "statusSince": null,
      "createdAt": "2026-11-05T17:03:34.053Z",
      "updatedAt": "2026-11-14T00:03:34.053Z",
      "closedAt": "2026-11-04T01:03:34.344Z",
      "closedReason": "Closed",
      "notes": 0
    }
  ],
  "next": null,
  "closedDays": 14
}
```

```
GET /v1/agents/m/wo?store=914&limit=1&cards=1       (card shortened here)
{
  "v": 1,
  "now": "2026-11-14T01:03:36.606Z",
  "state": "open",
  "sort": "status",
  "scope": 914,
  "stores": [
    914
  ],
  "rows": [
    {
      "store": 914,
      "wo": 7000001,
      "open": true,
      "statusId": 2,
      "status": "Need to order",
      "lane": "order",
      "device": "Galaxy S23 Ultra",
      "program": "Retail",
      "bin": null,
      "outcome": null,
      "cartValue": null,
      "cartDue": null,
      "lastCartValue": 199,
      "statusSince": "2026-11-09T01:03:35.373Z",
      "createdAt": "2026-11-05T17:03:34.053Z",
      "updatedAt": "2026-11-14T00:03:34.053Z",
      "closedAt": null,
      "closedReason": null,
      "notes": 3,
      "card": "v1.BEQv6vDN8Ad9DqyTWL-H-\u2026",
      "tags": [
        {
          "tag": "Priority",
          "color": "#d9534f"
        },
        {
          "tag": "Waiting on customer",
          "color": "#f0ad4e"
        },
        {
          "tag": "One-off",
          "color": null
        }
      ],
      "followUp": {
        "kind": "callback",
        "due": "2026-11-14"
      }
    }
  ],
  "next": "eyJzIjoic3RhdHVzIiwidCI6Im9wZW4iLCJlIjoiMjAyNi0xMS0wOVQwMTowMzozNS4zNzNaIiwic3QiOjkxNCwidyI6NzAwMDAwMX0",
  "lanes": {
    "order": 3,
    "start": 2,
    "work": 2,
    "wait": 2,
    "rfp": 2,
    "total": 11
  },
  "followUps": {
    "count": 3,
    "today": "2026-11-13"
  },
  "cards": true,
  "cardsFor": [
    914
  ],
  "noKey": []
}
```

Errors: `400 state: open, recent or closed`, `400 followups: 1 (open work orders only)`, `400 sort: …`, `400 lane: …`, `400 after: not a cursor from this list`, `400 store: all or a store number`, `403 not your store`, `403 no key for this store`.

### Closed list example

```
GET /v1/agents/m/wo?state=closed&store=914&limit=2
{
  "v": 1,
  "now": "2026-11-14T01:03:36.692Z",
  "state": "closed",
  "sort": "closed",
  "scope": 914,
  "stores": [
    914
  ],
  "rows": [
    {
      "store": 914,
      "wo": 7000010,
      "open": false,
      "statusId": 14,
      "status": "Sale complete",
      "lane": null,
      "device": "Galaxy S23 Ultra",
      "program": "Retail",
      "bin": null,
      "outcome": null,
      "cartValue": null,
      "cartDue": null,
      "lastCartValue": 149,
      "statusSince": null,
      "createdAt": "2026-11-05T17:03:34.053Z",
      "updatedAt": "2026-11-14T00:03:34.053Z",
      "closedAt": "2026-11-11T01:03:34.342Z",
      "closedReason": "Sale complete",
      "notes": 0
    },
    {
      "store": 914,
      "wo": 7000011,
      "open": false,
      "statusId": 15,
      "status": "Closed",
      "lane": null,
      "device": "Galaxy S23 Ultra",
      "program": "Retail",
      "bin": null,
      "outcome": null,
      "cartValue": null,
      "cartDue": null,
      "lastCartValue": null,
      "statusSince": null,
      "createdAt": "2026-11-05T17:03:34.053Z",
      "updatedAt": "2026-11-14T00:03:34.053Z",
      "closedAt": "2026-11-04T01:03:34.344Z",
      "closedReason": "Closed",
      "notes": 0
    }
  ],
  "next": "eyJzIjoiY2xvc2VkIiwidCI6ImNsb3NlZCIsImUiOiIyMDI2LTExLTA0VDAxOjAzOjM0LjM0NFoiLCJzdCI6OTE0LCJ3Ijo3MDAwMDExfQ"
}
```
`next` is null on the last page. The next page: `GET …?state=closed&store=914&limit=2&after=<next>`.

### Waymark on the open list: tags, follow-ups, the follow-ups filter

Waymark's own database (read only, never written) gives each **open-list row** and the **detail's `wo`** two more fields:

- `tags`: `[{ "tag": "Priority", "color": "#d9534f" }, …]` in the order they were put on (oldest first), at most 20; `[]` when none. `color` is the colour in the work order's own store's managed tag list; a tag that is not in that list (a one-off tag) has `"color": null`. Colours are the strings Waymark stores (a CSS colour such as `#d9534f`); show them as given. Who added a tag is never sent.
- `followUp`: `{ "kind": "rfp" | "callback", "due": "YYYY-MM-DD" }` or `null`. From Auto-Waymark's follow-up date: `rfp` = Ready for pickup (also the kind of old rows that have none), `callback` = Awaiting callback. `due` is the **store-local calendar date** (the zone is `tz` in Home, America/New_York today). A follow-up that was removed (the x) or whose work order is in Waymark's closed list is `null`; a closed work order never has one. `due` may be in the future: the row still carries it.
- Both are read per page in one batch (one tags and one follow-ups statement per store on the page). If Waymark's database cannot be read the rows come back with `tags: []` and `followUp: null` (never an error).

**Follow-ups filter**: `followups=1` (open list only; `followups=0` or absent = no filter; anything else is `400`) keeps only open work orders whose follow-up is **due today or overdue** (`due <= today`, store-local). It combines with `store`, `lane`, `sort`, `limit`, `after` and `cards`. With `state` other than `open` it is `400`.

The first page of an open list (no `after`) also has **`followUps`**, the count for the filter chip, next to `lanes`:
```
"followUps": { "count": 3, "today": "2026-11-13" }
```
`count` = open work orders in the request's stores with a follow-up due today or overdue (not narrowed by `lane` or `followups`, like the lane counts); `today` is the store-local date the server used, so the app can tell overdue (`due < today`) from due today. `count` is `null` if Waymark could not be read. Absent on later pages and on `recent` / `closed` lists. The count and the filter read at most 2000 due follow-ups.

```
GET /v1/agents/m/wo?followups=1&store=914&limit=2
{
  "v": 1,
  "now": "2026-11-14T01:03:36.701Z",
  "state": "open",
  "sort": "status",
  "scope": 914,
  "stores": [
    914
  ],
  "rows": [
    {
      "store": 914,
      "wo": 7000003,
      "open": true,
      "statusId": 13,
      "status": "Ready for pickup",
      "lane": "rfp",
      "device": "Galaxy S23 Ultra",
      "program": "Retail",
      "bin": null,
      "outcome": null,
      "cartValue": 149,
      "cartDue": 149,
      "lastCartValue": 149,
      "statusSince": "2026-11-13T01:03:34.149Z",
      "createdAt": "2026-11-05T17:03:34.053Z",
      "updatedAt": "2026-11-14T00:03:34.053Z",
      "closedAt": null,
      "closedReason": null,
      "notes": 1,
      "tags": [],
      "followUp": {
        "kind": "rfp",
        "due": "2026-11-12"
      }
    },
    {
      "store": 914,
      "wo": 7000007,
      "open": true,
      "statusId": 24,
      "status": "Ready for Diag",
      "lane": "start",
      "device": "Galaxy S23 Ultra",
      "program": "Retail",
      "bin": null,
      "outcome": null,
      "cartValue": null,
      "cartDue": null,
      "lastCartValue": null,
      "statusSince": "2026-11-13T20:03:34.248Z",
      "createdAt": "2026-11-05T17:03:34.053Z",
      "updatedAt": "2026-11-14T00:03:34.053Z",
      "closedAt": null,
      "closedReason": null,
      "notes": 0,
      "tags": [],
      "followUp": {
        "kind": "rfp",
        "due": "2026-11-13"
      }
    }
  ],
  "next": "eyJzIjoic3RhdHVzIiwidCI6Im9wZW4iLCJlIjoiMjAyNi0xMS0xM1QyMDowMzozNC4yNDhaIiwic3QiOjkxNCwidyI6NzAwMDAwN30",
  "lanes": {
    "order": 3,
    "start": 2,
    "work": 2,
    "wait": 2,
    "rfp": 2,
    "total": 11
  },
  "followUps": {
    "count": 3,
    "today": "2026-11-13"
  }
}
```

## `GET /v1/agents/m/wo/find?q=<digits>[&store=<id>][&limit=<n>]`: number lookup

`q` = 3 to 12 digits, no leading zero: an exact work order number or the start of one. Matches open **and closed** work orders in the phone's stores (or the one `store`). Rows are the same row as the list (no `card`). Exact match first, then ascending number; `limit` default 20, max 50; `more: true` when there were further matches. `400 q: 3 to 12 digits…` otherwise. A store the phone is not approved for: `403` (with `store=`) or simply not searched (without).

```
GET /v1/agents/m/wo/find?q=70000&limit=2
{
  "v": 1,
  "now": "2026-11-14T01:03:36.631Z",
  "q": "70000",
  "rows": [
    {
      "store": 914,
      "wo": 7000001,
      "open": true,
      "statusId": 2,
      "status": "Need to order",
      "lane": "order",
      "device": "Galaxy S23 Ultra",
      "program": "Retail",
      "bin": null,
      "outcome": null,
      "cartValue": null,
      "cartDue": null,
      "lastCartValue": 199,
      "statusSince": "2026-11-09T01:03:35.373Z",
      "createdAt": "2026-11-05T17:03:34.053Z",
      "updatedAt": "2026-11-14T00:03:34.053Z",
      "closedAt": null,
      "closedReason": null,
      "notes": 3
    },
    {
      "store": 914,
      "wo": 7000002,
      "open": true,
      "statusId": 9,
      "status": "Diagnostics",
      "lane": "work",
      "device": "Galaxy S23 Ultra",
      "program": "Retail",
      "bin": null,
      "outcome": null,
      "cartValue": 89,
      "cartDue": 89,
      "lastCartValue": 89,
      "statusSince": null,
      "createdAt": "2026-11-05T17:03:34.053Z",
      "updatedAt": "2026-11-14T00:03:34.053Z",
      "closedAt": null,
      "closedReason": null,
      "notes": 0
    }
  ],
  "more": true
}
```

## `GET /v1/agents/m/wo/<store>/<wo>[?sealed=1]`: detail

```
GET /v1/agents/m/wo/914/7000003
{
  "v": 1,
  "now": "2026-11-14T01:03:36.731Z",
  "wo": {
    "store": 914,
    "wo": 7000003,
    "open": true,
    "statusId": 13,
    "status": "Ready for pickup",
    "lane": "rfp",
    "device": "Galaxy S23 Ultra",
    "program": "Retail",
    "bin": null,
    "outcome": null,
    "cartValue": 149,
    "cartDue": 149,
    "lastCartValue": 149,
    "statusSince": "2026-11-13T01:03:34.149Z",
    "createdAt": "2026-11-05T17:03:34.053Z",
    "updatedAt": "2026-11-14T00:03:34.053Z",
    "closedAt": null,
    "closedReason": null,
    "notes": 1,
    "nextUpdate": "2026-11-14T05:03:34.149Z",
    "slaEnd": "2026-11-15T01:03:34.149Z",
    "rfpAt": null,
    "outcomeReason": null,
    "soldAt": null,
    "tags": [],
    "followUp": {
      "kind": "rfp",
      "due": "2026-11-12"
    }
  },
  "timeline": [
    {
      "statusId": 13,
      "status": "Ready for pickup",
      "lane": "rfp",
      "start": "2026-11-13T01:03:34.149Z",
      "end": null,
      "seconds": 86403,
      "current": true
    },
    {
      "statusId": 9,
      "status": "Diagnostics",
      "lane": "work",
      "start": "2026-11-11T03:03:34.149Z",
      "end": "2026-11-13T01:03:34.149Z",
      "seconds": 165600,
      "current": false
    }
  ],
  "timelineSource": "periods",
  "parts": {
    "state": null,
    "rows": []
  },
  "changes": [],
  "cart": {
    "value": 149,
    "total": 149,
    "paid": 0,
    "due": 149,
    "lines": [
      {
        "name": "Screen",
        "sku": "1001",
        "quantity": 1,
        "price": 149,
        "totalPrice": 149,
        "partStatus": "Reserved"
      },
      {
        "name": "Labor",
        "sku": "9",
        "quantity": 1,
        "price": 0,
        "totalPrice": 0,
        "partStatus": null
      }
    ]
  }
}
```

- `wo`: the row above plus the extra times, `tags` and `followUp` (see Waymark above). `timeline`: every open status the work order has had, **newest first**: `start`, `end` (null while current), `seconds` (end or now minus start; recompute from `now` for a live clock), `current`, `lane`. Sources: `status_periods` (`timelineSource: "periods"`, built from Portal's status history); if a work order has none yet, rebuilt from the tracker's change rows (`"changes"`; the first interval's `start` and `seconds` are then null); else `[]` with `timelineSource: null`. The closed statuses (Sale complete 14, Closed 15, Cancelled 25) have no interval of their own: a closed work order's timeline ends with its last open status, and `wo.closedAt` / `wo.closedReason` say when and how it closed. At most 100 entries.
- `cart`: `value` (pre-tax, partner credit ignored), `total`, `paid`, `due` (dollars, null when unknown), `lines` (at most 60; `name`, `sku`, `quantity`, `price`, `totalPrice`, `partStatus`; all plain, no names of people). Portal empties a cart at Sale complete, so a sold work order's lines can be empty; `wo.lastCartValue` and `parts` keep what was sold.
- `parts`: the parts **sold** on the work order, from the sales order Portal keeps after Sale complete (the tracker's `inv_wo_parts`, `retrace-wo-parts.js`). `parts.state` says whether it has been read: `done` (rows below), `empty` (read, no part lines: labor / credit only), `pending` (being fetched), `failed` (will be retried) or `gave_up` (not obtainable), `null` (not asked for yet: open work orders, and sold ones not reached yet). `parts.rows` (at most 100, by line): `line` (the sales line id), `label` (the inventory label, e.g. `176255-0000514371`; null for a quantity-only part), `item` (item number), `sku`, `name` (the line's name, else the item's name from Retrace, else null), `quantity`, `price` (each, before tax), `status` (Portal's serial status on the line, normally `Sold`), `soldAt`. No staff or customer fields. The detail's `cart.lines` stays the live cart (empty after the sale); `parts` is what was sold.
- `changes`: the work order's status and next-update changes as the tracker saw them, **newest first, at most 100**: `{ "at": ISO, "field": "status" | "nextUpdate", "old": …, "new": … }`. For `status`, `old` / `new` are status **names** (resolved through the tracker's status table; an id it has no name for comes back as the id in text, e.g. `"77"`; `old` is null for the first sight of the work order). For `nextUpdate`, `old` / `new` are ISO UTC times, or null (not set / cleared / not a time). `at` is when the tracker noticed the change, not when it happened in Portal, so it can lag by minutes. **Cart value is not in `changes`**: the tracker does not record one field for it (see below). Only these two fields are ever returned; every other change row (cart lines, staff, the audit trail, dates) is left out. Change rows older than about 6 months may be archived.
- `sealed=1` adds `sealed: { card, snapshot: { id, fetchedAt, sealed } }`: `card` is the sealed search card (null if none), `snapshot.sealed` the **latest** sealed snapshot, `snapshot.fetchedAt` when the tracker last read the work order from Portal (show it as "as of"). `snapshot` is null when there is none. A snapshot can be large (every note); fetch it only when the detail is opened. Logged as above.

```
GET /v1/agents/m/wo/914/7000003?sealed=1   (blobs shortened here)
{
  "card": "v1.BJFGPW2ucb2p2pTNYz36w…",
  "snapshot": {
    "id": 6,
    "fetchedAt": "2026-11-13T17:02:23.485Z",
    "sealed": "v1.BO7dRLYHQdFsbszn2dMdT…"
  }
}
```

**Closed work order detail (the new fields), `GET /v1/agents/m/wo/914/7000010`:**
```
{
  "v": 1,
  "now": "2026-11-14T01:03:36.716Z",
  "wo": {
    "store": 914,
    "wo": 7000010,
    "open": false,
    "statusId": 14,
    "status": "Sale complete",
    "lane": null,
    "device": "Galaxy S23 Ultra",
    "program": "Retail",
    "bin": null,
    "outcome": null,
    "cartValue": null,
    "cartDue": null,
    "lastCartValue": 149,
    "statusSince": null,
    "createdAt": "2026-11-05T17:03:34.053Z",
    "updatedAt": "2026-11-14T00:03:34.053Z",
    "closedAt": "2026-11-11T01:03:34.342Z",
    "closedReason": "Sale complete",
    "notes": 0,
    "nextUpdate": "2026-11-14T05:03:34.272Z",
    "slaEnd": "2026-11-15T01:03:34.272Z",
    "rfpAt": null,
    "outcomeReason": null,
    "soldAt": "2026-11-11T13:03:34.272Z",
    "tags": [],
    "followUp": null
  },
  "timeline": [
    {
      "statusId": 9,
      "status": "Diagnostics",
      "lane": "work",
      "start": "2026-11-01T13:03:34.272Z",
      "end": "2026-11-11T13:03:34.272Z",
      "seconds": 864000,
      "current": false
    }
  ],
  "timelineSource": "periods",
  "parts": {
    "state": "done",
    "rows": [
      {
        "line": "L1",
        "label": "176255-0000514371",
        "item": "176255",
        "sku": "176255",
        "name": "Screen assembly",
        "quantity": 1,
        "price": 129.99,
        "status": "Sold",
        "soldAt": "2026-11-11T13:03:35.879Z"
      },
      {
        "line": "L2",
        "label": "176300-0000000009",
        "item": "176255",
        "sku": "176300",
        "name": "Galaxy S23 screen",
        "quantity": 2,
        "price": 5,
        "status": "Sold",
        "soldAt": "2026-11-11T13:03:35.879Z"
      }
    ]
  },
  "changes": [
    {
      "at": "2026-11-11T14:03:35.888Z",
      "field": "status",
      "old": "Sale complete",
      "new": "77"
    },
    {
      "at": "2026-11-11T13:03:35.887Z",
      "field": "status",
      "old": "Diagnostics",
      "new": "Sale complete"
    },
    {
      "at": "2026-11-10T07:03:35.883Z",
      "field": "nextUpdate",
      "old": null,
      "new": "2026-11-20T09:30:00.000Z"
    },
    {
      "at": "2026-11-09T21:03:35.882Z",
      "field": "nextUpdate",
      "old": "2026-11-13T15:00:00.000Z",
      "new": null
    },
    {
      "at": "2026-11-05T17:03:35.882Z",
      "field": "nextUpdate",
      "old": null,
      "new": "2026-11-13T15:00:00.000Z"
    },
    {
      "at": "2026-11-01T13:03:35.881Z",
      "field": "status",
      "old": null,
      "new": "Diagnostics"
    }
  ],
  "cart": {
    "value": null,
    "total": null,
    "paid": null,
    "due": null,
    "lines": []
  }
}
```

**Why there is no cart-value history**: the tracker stores the cart as the flattened plain part and diffs it field by field. The only cart totals in it are `cart.payment.total` (Portal's cart total **including tax**, and it falls to 0 when Portal empties the cart at the sale) and individual line fields (`cart.items.N.price`, …); the value the app shows (`cartValue` / `lastCartValue`: lines before tax, partner credit ignored) is **computed** and written to a column, never as a change row. No single recorded field represents "cart value", so the server does not invent one. What exists: the current `cartValue`, and `lastCartValue` for a sold work order.

## Sealed data: exact format, and a test vector

Formats and keys are exactly `MOBILE-API.md` ("Sealed data and wrapped store keys"). For this API:

| Blob | Where | `aad` (ASCII) | Plaintext |
|---|---|---|---|
| card | `rows[].card`, `sealed.card` | `card\|<store>\|<wo>` | gzip(UTF-8 JSON), the card below |
| snapshot | `sealed.snapshot.sealed` | `snapshot\|<store>\|<wo>` | gzip(UTF-8 JSON), the snapshot below |

Open with the **store private key** (the PKCS#8 key from hop 1; `wrapped` in `/me` is opened with the phone key, `aad = agentkey|<deviceId>|<store>`). Steps: base64url-decode after `v1.` (no padding) → `epk`(65) `iv`(12) `ct`(rest, tag last) → ECDH P-256 shared x → HKDF-SHA256 (salt = the 65 epk bytes, info = `aethernet-tracker v1`) → AES-256-GCM, aad bytes as above → **gunzip** → JSON. A wrong `aad` (another store or work order) fails the GCM tag; build it from the row's own `store` and `wo`.

### Card plaintext (`cardOf`, tracker-worker/src/shape.js)

`{ name, customerId, phones: ["5555550123", …], emails: ["a@b.com", …], imei, serial, claim }`: `phones` are 10 digits (US, no country code, deduplicated), `emails` lower case, `name` the customer's full name; `imei`, `serial`, `claim` and `customerId` are strings or null. Search by name (case-insensitive, any word), by phone (digits, suffix / prefix), by IMEI or serial (digits, suffix of 4+), claim.

### Snapshot plaintext (the whole detail the browser read from Portal, passcodes replaced by `[removed]`)

```
{ workorder:     { workorder: { workorderId, storeId, workorderStatusId, WorkorderStatus: { name }, programId, Program: { name },
                                 CustomerDevice: { imei, serial, DeviceCatalog: { name }, name, … }, claimNumber, createdAt, updatedAt,
                                 createdBy, slaEndTime, nextUpdate, WorkorderBinDeviceLocation: { WorkorderBin: { name } }, … } },
  audit_trail:    [{ workorderStatusId, createdAt, createdBy, completed }, …],
  customer_data:  { customerId, CustomerDatum: { fullName, givenName, familyName }, CustomerDataPhones: [{ phone }], CustomerDataEmails: [{ email }] } | null,
  notes:          { total, latestManualNote, notes: [{ noteId, noteType, noteTag, noteText, createdAt, UserDatum: { userId, givenName, familyName, … } }, …] } | null,
  cart:           { cartItems: […], payment: { total, amountPaid, amountDue }, … } | null,
  events:         { events: […] } | null,
  list_row:       { … Portal's list row … }   (optional) }
```

- **Notes** are `notes.notes[]`, newest first as Portal pages them. Each: `noteText` (string), `createdAt` (ISO UTC), `noteType` (**1 = automatic**: "<tech> started Diagnostics", status changes; **2 = manual**: written by staff, the ones to show first; the intake note has `noteTag: "initial_checkin"`), `noteTag` (string or null, e.g. `contacted`, `initial_checkin`), `noteId`. The **author** is `UserDatum` (`givenName`, `familyName`, `userId`); it can be absent on some notes (treat as unknown). `notes.total` is Portal's count; the stored list is at most 600 notes (20 pages of 30), so if `notes.length < total` say so. `latestManualNote` is the newest manual note as Portal returned it (same shape).
- **Customer contact**: `customer_data.CustomerDatum.fullName`, `CustomerDataPhones[].phone` (formatted any way: strip to digits), `CustomerDataEmails[].email`. The card is the cleaner source for name, phones and emails; use the snapshot for anything else.
- **IMEI / serial**: `workorder.workorder.CustomerDevice.imei` and `.serial` (the card has them too). Device passcodes are never stored (`[removed]`).
- Shapes are Portal's own (the tracker stores Portal's answers as read); only the keys above are relied on by the server's own code and tests. Anything else may be missing: read every field as optional.
- Not in the snapshot: nothing about who the *tracker* read it for. Note authors are only what Portal gives in `UserDatum`.

### Test vector (real server crypto, TEST key only, never a production key)

Made with `src/crypto.js` `sealJson` against a throwaway store key; `test/mobile-wo.test.mjs` asserts these values still open (so this doc cannot drift from the server). Store 914, work order 700000123.

Store private key, PKCS#8 DER, base64url (no padding); import as an EC P-256 `PrivateKey`:
```
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgj7zkPtASOtqIrFPoNpVgvyq-isqyjIiXfChJly3kkvehRANCAATukLv1ZEl6KV_vINoEQwkqbIn2D8vIAf7vWLDbYhthTCAMMnVYF4LQo-T3B_kq5_3lH3gv1-UVUVl8z6M-hemF
```
Store public key JWK: `{"kty":"EC","crv":"P-256","x":"7pC79WRJeilf7yDaBEMJKmyJ9g_LyAH-71iw22IbYUw","y":"IAwydVgXgtCj5PcH-Srn_eUfeC_X5RVRWXzPoz6F6YU"}`

Card: `aad = card|914|700000123`
```
v1.BOk3HTerTewDZNoHNFtu78uZQ9gBIo1zwU-nckLZkXC6ZTNFlJ9R2-zh7s997jswBl5a5QpThsFq8eCGzGcnsmBo7TUjdz_f5Zln-bUwvJKkKO3duddXkpz7ZxLzIF-tjuPbjMrvy-Z9eLkyTgiZiham3U9QVAC9Pz3Ujl_4jysrqgcQ7GGF_EowscY_-mNVLKXXieYgRTy0gJXGFBpIb3Yh63PxHKkbDjvySHPz8J42fi_3y9oQxMlkM7_ohzUHYkxFn8Xlnne0MB06nshBBL-iK_tXrjmi30Uvxo0I6nV1W-XWNeEivtSF4-mrwqWQZ7dzBzwYUiADwSMMwApW
```
Expected card JSON (as `JSON.stringify` prints it; the gunzipped bytes are exactly this UTF-8 text):
```
{"name":"Sam Sample","customerId":"C-TEST-1","phones":["5555550123"],"emails":["sam.sample@example.com"],"imei":"490154203237518","serial":"F2LTESTSERIAL","claim":"CLM-TEST-1"}
```

Snapshot: `aad = snapshot|914|700000123`
```
v1.BOg1CDkIgRBq-zZmfoPa9Vm715qQK7I_-3Wc9ROFADKXXlyrYeiVBkYbs7KfkT4o45Lyjdqkf1xcMc3VN5apTZ06-FDA0au6G2Ud_bBNNw4EoD_P3AZtjtetfsn5eHl8Bckt8m3ai3Sw-r_kd80M0STXufzyQCNZlXZtjbNQ2GMxPAYDToJWuJKn3NlwUjctKzu3uAtlVFzmYnVl21JOnxhF2sddUxlgQcjgxfOdSYi5sZTk00ZvMIY8WCjm8T7Xn1Nv2LDHlsY9_CMh3Mufj-qmb1sLfSngnuDpxfIC5_m8yyQkPfOb9EePMNzEtnMiukXGvrSxpVgpfy0Js5n6GgsU3bLb9UAQvY4AkqVkARLe6g8DGsqcgudejMQLk4fZK2tIwiNMWmZ_owZfhtABPAv0tvBvjF6GR2d7gDPGjDyGUsFGG-P4GwMdsvLM3PxUKKZe2QgZCYgvYVqpaRq2f6Te0pWOb8A03YwSNUc9NaYtwkH8-iGrGU3OqN6j3JIOWQhnwvtWRBqwGYqXk46Bcf9ZolZzfGuHI0K0F_KZ9oZhsM2eRi8tACFByhZ5n3BQSBsRbh4rKSifs-FP4UFNSB3BdKZVyAdWt2RLtW8_2B87QK7K_q2dFzCCr4yp7IWFdlZj_0V51AEHfMHz4qFF1pjDdOAZAXSynl1h6AGoAFzW9Uli_rrtooYJJOZHaQySExkRJuHyTGddtW3xsK2MQ9cVuzBv_z6Uu0UAEYJa1yJzwV2oEHCju5V4fJQzKR8200ZKjLTLH0fdD5Bc3VJ3oeKV95X7ig9XjfZe8TAkhw6ycJvW-zxzgPhUcwam8nHL5dqm3qa-HXc
```
Expected snapshot JSON (parsed; key order is not significant):
```
{
  "workorder": {
    "workorder": {
      "workorderId": 700000123,
      "storeId": 914,
      "workorderStatusId": 9,
      "CustomerDevice": {
        "imei": "490154203237518",
        "serial": "F2LTESTSERIAL",
        "DeviceCatalog": {
          "name": "Galaxy S23 Ultra"
        }
      }
    }
  },
  "audit_trail": [
    {
      "workorderStatusId": 9,
      "createdAt": "2026-11-10T15:00:00.000Z",
      "createdBy": "Test Tech"
    }
  ],
  "customer_data": {
    "customerId": "C-TEST-1",
    "CustomerDatum": {
      "fullName": "Sam Sample"
    },
    "CustomerDataPhones": [
      {
        "phone": "555-555-0123"
      }
    ],
    "CustomerDataEmails": [
      {
        "email": "sam.sample@example.com"
      }
    ]
  },
  "notes": {
    "total": 2,
    "latestManualNote": null,
    "notes": [
      {
        "noteId": "n2",
        "noteType": 2,
        "noteTag": null,
        "noteText": "Customer asked for a text when it is ready.",
        "createdAt": "2026-11-11T14:30:00.000Z",
        "UserDatum": {
          "userId": 77,
          "givenName": "Test",
          "familyName": "Tech"
        }
      },
      {
        "noteId": "n1",
        "noteType": 1,
        "noteTag": null,
        "noteText": "Test Tech started Diagnostics.",
        "createdAt": "2026-11-10T15:00:00.000Z",
        "UserDatum": {
          "userId": 77,
          "givenName": "Test",
          "familyName": "Tech"
        }
      }
    ]
  },
  "cart": {
    "cartItems": [
      {
        "name": "Screen",
        "sku": "1001",
        "price": 199,
        "quantity": 1,
        "totalPrice": 199
      }
    ],
    "payment": {
      "total": 199,
      "amountPaid": 0,
      "amountDue": 199
    }
  }
}
```

Negative check: opening the card blob with `aad = snapshot|914|700000123` must fail (GCM tag mismatch).

## Notes for the Android implementer

**Locked (no store keys in memory)**: Home, the list without `cards`, `find`, the plain detail (header, timeline, cart). Show the number, device, status, lane chip, time in status, program, cart value. No customer name, issue or Urgent anywhere (not available plain).

**Unlock** (owner's biometrics/PIN gate on the phone, then open the wrapped store keys from `/me` with the Keystore key): fetch `GET /wo?state=open&cards=1&limit=100` per page until `next` is null (a store has roughly 30-150 open work orders), plus `state=recent&cards=1&closedDays=7`; open each card with the store key for `row.store`; keep name / phones / emails / IMEI / serial in memory and search locally (names case-insensitive by word, phones by digit suffix, IMEI by suffix). The Number tab can search the downloaded list first, then call `find` for anything not in it (closed or older). Opening a work order: `GET /wo/<store>/<wo>?sealed=1`, decrypt the snapshot, show notes (manual first) and the timeline. Each of these downloads is logged for the owner, so do not prefetch snapshots; fetch one when the user opens it.

**Refresh**: the tracker refreshes a work order about every 10 minutes while a store's browser is open. Re-list on screen open and pull-to-refresh, not faster than about once a minute (the Worker limit is 240 requests a minute per IP). `snapshot.fetchedAt` / `updatedAt` tell how fresh a work order is; Home's `asOf` / `stale` tell whether scanning is behind.

**Cache**: plain list and detail may be cached in memory or app storage briefly (a few minutes) for instant redraw: they hold no customer data. Sealed blobs may be kept only as the encrypted strings the server sent (they are useless without the store key) or, better, not at all. When the app locks: drop the store keys and every decrypted card, snapshot, note, name, phone and IMEI from memory, and clear any screen text holding them.

**Never write to disk in plaintext**: the unwrapped store private keys, the decrypted cards or snapshots, notes, customer names, phones, emails, IMEI / serial, the search index built from cards, search terms that are a name / phone / IMEI, screenshots (set `FLAG_SECURE` on the Work orders and detail screens), logs, crash reports, notifications and the clipboard (if the user copies a phone number, clear it after a short time). The device token may sit in encrypted storage (it opens nothing sealed by itself). Do not put names or numbers in URLs: the server never takes a name, phone or IMEI from the phone (only a work order number for `find`), and the app must not invent such a parameter.

**Time**: all times ISO UTC; format in the store's zone (`tz` in Home), not the phone's. Time in status = `now - statusSince` using the response's `now` (or the phone clock corrected by it); `null` shows a dash.

**Stale pages**: the status can change between pages; if a row's status disagrees with the detail you open, trust the detail.

## Performance and indexes

Query plans checked against the real schema (SQLite `EXPLAIN QUERY PLAN`):
- open list: `wo_open (store, is_open, status_id)` for the work orders, `status_periods` primary key `(store, wo, start_at)` for the open interval (LEFT JOIN, one probe per open work order), sorted in a temp B-tree over the open rows only (tens to a few hundred). The page is selected from plain key columns first and only then joins back for `plain` (`json_extract` of bin and note count) and, with `cards=1`, `card`: no sealed or JSON column is read for rows that are not on the page. No per-row subquery over `snapshots` anywhere; the one latest snapshot of a detail is `snap_wo (store, wo, id)`.
- `find`: one primary-key range seek per store and possible number length (at most 10 per store), in one batch.
- detail: primary key, `status_periods` PK, `changes` (only as the fallback) via `chg_wo (store, wo, id)`, `snap_wo`.
- `recent` and `closed`: need `wo_closed (store, is_open, closed_at)` (`migrations/2026-11-13-mobile-wo-index.sql`, also in `schema.sql`; **it must be applied to the live tracker database before the Linkpearl build that uses `state=closed` ships**: without it both stay correct but read every closed work order of a store per page). With it, `recent` is a range seek and `closed` is one index-ordered seek per store (`EXPLAIN QUERY PLAN`: `SEARCH w USING INDEX wo_closed (store=? AND is_open=? AND closed_at>? AND closed_at<?)` plus a small sorter that only orders equal close times by number), each stopping after `limit + 1` entries; the stores' streams are merged in the Worker. Equal close times are ordered by store, then number.
- detail additions: `inv_wo_parts` / `inv_wo_sold` by primary key `(store, wo)`, `changes` through `chg_wo (store, wo, id)` newest first with the two-field filter applied per row (a work order has tens to a few hundred change rows; no extra index needed).
- Waymark: primary-key seeks `(store, wo)` on `wo_tags` and `auto_marks`, `list` by `(store, name)`; the follow-ups filter reads due marks with one `auto_marks` scan limited to the phone's stores (the table only holds work orders currently in Ready for pickup / Awaiting callback).
- Possible later: `bin` and the note count are read with `json_extract` over the stored `plain` text for the 25-100 rows of a page (the plain text can be tens of KB). If that ever shows in timings, store them as columns at upload time (`bin`, `notes_total`) in `index.js`.

## Limits at a glance

page 25 (max 100) · find 20 (max 50), `q` 3-12 digits · `closedDays` 1-14 (default 7, `state=recent` only; `state=closed` has no window) · timeline 100 · cart lines 60 · parts 100 · changes 100 · tags 20 a work order · follow-ups read for the filter 2000 · cursor valid only with the same state and sort.
