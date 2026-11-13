# Linkpearl phone API: work order lookup (`/v1/agents/m/wo…`)

Server side of the Work orders tab (list, search, detail, unlock). Implemented in `src/mobile-wo.js`, tests in `test/mobile-wo.test.mjs` (the examples below are real output from those tests, invented data). Read `MOBILE-API.md` first: it defines the base URL, the headers (`x-aethernet-key`, `Authorization: Bearer <id>.<token>`), registration, the wrapped store keys and the error shape `{"error":"…"}`. All answers are JSON, `cache-control: no-store`, GET only (any other method is `404`).

## Who may call what

- The caller is an approved phone; `device.stores` are its approved stores. Every route is limited to them. A store outside them is `403 {"error":"not your store"}` (never silently dropped from `all`); a malformed store is `400`; an unknown work order is `404 {"error":"no such work order"}`.
- Sealed blobs (the card, the snapshot) are only sent for a store the phone holds a wrapped key for (`keys` in `/me`). Without one: `cards=1` skips that store's cards (see below), `sealed=1` is `403 {"error":"no key for this store"}`.
- Every send of sealed data is written to the tracker's `access_log` (what the admin site's access log page shows) with the phone as the actor: `cards=1` writes one row per store (action `list`, detail `phone cards <n> <first 8 of device id>`), `sealed=1` writes one row (action `open`, store, wo, detail `phone sealed <8 hex>`), actor `device:<phone name>`. The row is written before the blob is returned. Plain reads (list without cards, find, plain detail) are not logged. Rows are pruned after 400 days like all log rows.
- No customer or staff name, phone, email or IMEI is ever in a plain response. (Staff names exist in plain only inside the stored `auditTrail.createdBy`, `workorder.createdBy / updatedBy` and `partEvents`; this API never reads them.)
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
| `cartValue`, `cartDue` | `cart_value` (before tax, partner credit ignored), `cart_due` | dollars, null if no cart seen |
| `statusSince` | `status_periods` open interval, only if it is the current status | ISO UTC, **null = unknown** (never `updatedAt`); always null for closed |
| `createdAt`, `updatedAt`, `closedAt` | `created_at`, `api_updated_at` (Portal's own updatedAt), `closed_at` | ISO UTC or null. `closedAt` is when the tracker recorded the close |
| `notes` | `plain.notes.total` | note count, null when no plain part is stored yet |

Detail adds: `nextUpdate`, `slaEnd`, `rfpAt`, `outcomeReason`, `closedReason`, `soldAt` (all ISO or null), the timeline and the cart.

**The mockups want but the tracker does not store in plain (so they are not in any response):**
- the customer name shown on every card (sealed in the card; the app shows it after unlocking, from the card it already holds);
- the issue / repair summary ("Screen", "Battery"): not in the plain part. The cart lines are the closest plain thing (detail only, `cart.lines[].name`), but which line is "the repair" is a guess the server does not make; the full text is in the sealed snapshot (the check-in note and the workorder). A reasonable app rule after unlocking: show the first cart line name, or the sealed intake note;
- the "Urgent" flag / attention state: not stored anywhere (Assize runs in the browser and its alerts live in the alerts stream, not on the work order). Not available here;
- `Sandbox #999999` style store labels: use the store id and Home's `stores[].name`.

## `GET /v1/agents/m/wo`: the list

Query: `store=<id>|all` (default `all` = the phone's approved stores), `state=open|recent` (default `open`), `lane=order,start,work,wait,rfp` (open only; comma list), `sort=status|updated|closed` (default `status`: longest in status first; `updated`: newest Portal update first; `closed`: newest close first, `recent` only, and the default there), `limit` (default 25, max 100; anything unparsable is the default), `after=<cursor>`, `closedDays=1..14` (`recent` only, default 7, clamped), `cards=1`.

- `open`: `is_open = 1`. `recent`: closed (`is_open = 0`) with `closed_at` within `closedDays` days.
- **Retention window for `recent`**: default **7 days, at most 14**. The tracker keeps every work order row forever (only older snapshots and change rows are archived after 183 days, and a work order's latest snapshot is always kept), so storage is not the limit; 14 is the same maximum the Mac audit's `/v1/agents/wos?closedDays=` uses, and a week matches the time people still ask about a finished repair. Older closed work orders are reachable by number through `/find`.
- Sort is stable and keyset-paged: the cursor (`next`) is opaque (base64url JSON of the last row's sort key, store and number); pass it back unchanged with the same `state` and `sort`, otherwise `400`. `next` is null on the last page. Rows with unknown time in status sort after those with a known one (then by store, number). Rows can change between pages (a status moves): a row may then appear on neither or both pages; refresh from the top when it matters.
- `lanes` (first page of an `open` list only, i.e. when `after` is absent): counts of all open work orders in scope, **not narrowed by `lane`**, the same numbers as Home's `lanes`. Use it for the filter chips.
- `cards=1` adds `card` to each row (see "Sealed data"); top-level `cards: true`, `cardsFor: [stores with cards]`, `noKey: [stores the phone has no key for]`. A row's `card` is null when the work order has no card yet or its store is in `noKey`. `cards=1&store=<id>` for a keyless store is `403 no key for this store`.
- Size: about 330 bytes a row without cards (25 rows ≈ 8 KB); with cards add roughly 0.5 KB a row (100 rows ≈ 60 KB). Page with `cards=1` only after unlocking.

```
GET /v1/agents/m/wo?store=914&limit=2&lane=order,work,rfp
{
  "v": 1,
  "now": "2026-11-13T17:02:25.294Z",
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
      "statusSince": "2026-11-08T17:02:24.673Z",
      "createdAt": "2026-11-05T09:02:23.384Z",
      "updatedAt": "2026-11-13T16:02:23.384Z",
      "closedAt": null,
      "notes": 3
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
      "statusSince": "2026-11-12T17:02:23.484Z",
      "createdAt": "2026-11-05T09:02:23.384Z",
      "updatedAt": "2026-11-13T16:02:23.384Z",
      "closedAt": null,
      "notes": 1
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
  }
}
```

```
GET /v1/agents/m/wo?store=914&state=recent&closedDays=14&limit=1
{
  "v": 1,
  "now": "2026-11-13T17:02:25.319Z",
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
      "statusSince": null,
      "createdAt": "2026-11-05T09:02:23.384Z",
      "updatedAt": "2026-11-13T16:02:23.384Z",
      "closedAt": "2026-11-10T17:02:23.688Z",
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
  "now": "2026-11-13T17:02:25.309Z",
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
      "statusSince": "2026-11-08T17:02:24.673Z",
      "createdAt": "2026-11-05T09:02:23.384Z",
      "updatedAt": "2026-11-13T16:02:23.384Z",
      "closedAt": null,
      "notes": 3,
      "card": "v1.BFMZcvPCbmXGp_ge3inAi…"
    }
  ],
  "next": "eyJzIjoic3RhdHVzIiwidCI6Im9wZW4iLCJlIjoiMjAyNi0xMS0wOFQxNzowMjoyNC42NzNaIiwic3QiOjkxNCwidyI6NzAwMDAwMX0",
  "lanes": {
    "order": 3,
    "start": 2,
    "work": 2,
    "wait": 2,
    "rfp": 2,
    "total": 11
  },
  "cards": true,
  "cardsFor": [
    914
  ],
  "noKey": []
}
```

Errors: `400 state: open or recent`, `400 sort: …`, `400 lane: …`, `400 after: not a cursor from this list`, `400 store: all or a store number`, `403 not your store`, `403 no key for this store`.

## `GET /v1/agents/m/wo/find?q=<digits>[&store=<id>][&limit=<n>]`: number lookup

`q` = 3 to 12 digits, no leading zero: an exact work order number or the start of one. Matches open **and closed** work orders in the phone's stores (or the one `store`). Rows are the same row as the list (no `card`). Exact match first, then ascending number; `limit` default 20, max 50; `more: true` when there were further matches. `400 q: 3 to 12 digits…` otherwise. A store the phone is not approved for: `403` (with `store=`) or simply not searched (without).

```
GET /v1/agents/m/wo/find?q=70000&limit=1
{
  "v": 1,
  "now": "2026-11-13T17:02:25.327Z",
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
      "statusSince": "2026-11-08T17:02:24.673Z",
      "createdAt": "2026-11-05T09:02:23.384Z",
      "updatedAt": "2026-11-13T16:02:23.384Z",
      "closedAt": null,
      "notes": 3
    }
  ],
  "more": true
}
```

## `GET /v1/agents/m/wo/<store>/<wo>[?sealed=1]`: detail

```
{
  "v": 1,
  "now": "2026-11-13T17:02:25.346Z",
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
    "statusSince": "2026-11-12T17:02:23.484Z",
    "createdAt": "2026-11-05T09:02:23.384Z",
    "updatedAt": "2026-11-13T16:02:23.384Z",
    "closedAt": null,
    "notes": 1,
    "nextUpdate": "2026-11-13T21:02:23.484Z",
    "slaEnd": "2026-11-14T17:02:23.484Z",
    "rfpAt": null,
    "outcomeReason": null,
    "closedReason": null,
    "soldAt": null
  },
  "timeline": [
    {
      "statusId": 13,
      "status": "Ready for pickup",
      "lane": "rfp",
      "start": "2026-11-12T17:02:23.484Z",
      "end": null,
      "seconds": 86402,
      "current": true
    },
    {
      "statusId": 9,
      "status": "Diagnostics",
      "lane": "work",
      "start": "2026-11-10T19:02:23.484Z",
      "end": "2026-11-12T17:02:23.484Z",
      "seconds": 165600,
      "current": false
    }
  ],
  "timelineSource": "periods",
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

- `wo`: the row above plus the extra times. `timeline`: every open status the work order has had, **newest first**: `start`, `end` (null while current), `seconds` (end or now minus start; recompute from `now` for a live clock), `current`, `lane`. Sources: `status_periods` (`timelineSource: "periods"`, built from Portal's status history); if a work order has none yet, rebuilt from the tracker's change rows (`"changes"`; the first interval's `start` and `seconds` are then null); else `[]` with `timelineSource: null`. The closed statuses (Sale complete 14, Closed 15, Cancelled 25) have no interval of their own: a closed work order's timeline ends with its last open status, and `wo.closedAt` / `wo.closedReason` say when and how it closed. At most 100 entries.
- `cart`: `value` (pre-tax, partner credit ignored), `total`, `paid`, `due` (dollars, null when unknown), `lines` (at most 60; `name`, `sku`, `quantity`, `price`, `totalPrice`, `partStatus`; all plain, no names of people). Portal empties a cart at Sale complete, so a sold work order's lines can be empty.
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

## Performance, indexes and a suggested migration

Query plans checked against the real schema (SQLite `EXPLAIN QUERY PLAN`):
- open list: `wo_open (store, is_open, status_id)` for the work orders, `status_periods` primary key `(store, wo, start_at)` for the open interval (LEFT JOIN, one probe per open work order), sorted in a temp B-tree over the open rows only (tens to a few hundred). The page is selected from plain key columns first and only then joins back for `plain` (`json_extract` of bin and note count) and, with `cards=1`, `card`: no sealed or JSON column is read for rows that are not on the page. No per-row subquery over `snapshots` anywhere; the one latest snapshot of a detail is `snap_wo (store, wo, id)`.
- `find`: one primary-key range seek per store and possible number length (at most 10 per store), in one batch.
- detail: primary key, `status_periods` PK, `changes` (only as the fallback) via `chg_wo (store, wo, id)`, `snap_wo`.
- `recent`: uses `wo_open` for `(store, is_open = 0)` and then filters `closed_at` over **every closed work order of the store** (it grows forever). Fine today, it will not stay fine. Suggested additive migration (not applied; `schema.sql` and a `migrations/` file belong to someone else):
  `CREATE INDEX IF NOT EXISTS wo_closed ON workorders (store, is_open, closed_at);`
  With it the `recent` query becomes a range seek.
- Possible later: `bin` and the note count are read with `json_extract` over the stored `plain` text for the 25-100 rows of a page (the plain text can be tens of KB). If that ever shows in timings, store them as columns at upload time (`bin`, `notes_total`) in `index.js`.

## Limits at a glance

page 25 (max 100) · find 20 (max 50), `q` 3-12 digits · `closedDays` 1-14 (default 7) · timeline 100 · cart lines 60 · cursor valid only with the same state and sort.
