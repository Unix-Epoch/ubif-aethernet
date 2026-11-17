# Linkpearl alerts API

Part of the phone API (`MOBILE-API.md`: same app key, same `Authorization: Bearer <id>.<token>`, same error shape `{ "error": "…" }`). Code: `src/mobile-alerts.js`, tests: `test/mobile-alerts.test.mjs`, storage: `migrations/2026-11-13-mobile-alerts.sql` and `migrations/2026-11-16-mobile-alerts-items.sql`.

There is **no push service**. The server evaluates rules every 10 minutes and keeps a feed of alerts. The app's background check (WorkManager, about every 15 minutes) asks `GET /v1/agents/m/alerts/new?since=<cursor>` and raises local notifications itself. Every route is limited to the phone's approved stores (`/me` → `stores`). A store outside them is `403 {"error":"not your store"}` where a store can be named. `/v1/agents/m/push…` answers `404` (no push service).

No alert ever carries a customer name, phone, e-mail, IMEI or a staff name. Facts are numbers, a status name, times, a due date and money totals. Work order and sales order numbers are the only identifiers.

## Alert entry

```
{ "id": 412, "store": 914, "type": "stuck", "wo": 700000014, "at": "2026-10-15T15:05:00.000Z", …facts… }
```

`id` is the cursor value (integers, increasing, never reused). `at` is when the server raised it (ISO UTC). `wo` is `null` when the alert is not about one work order. The facts by type:

| type | raised when | facts | sentence (the phone composes it; store name from Home's `stores`) |
|---|---|---|---|
| `stuck` | an open work order has been in its current status longer than the threshold | `statusId`, `status` (name), `days` (whole days at the moment it was raised), `since` (ISO, when the status began) | "Work order **700000014** has been in **Repair summary** for **5 days**" ("1 day" when 1) |
| `pickup` | devices at Ready for pickup for longer than the threshold; one per store per day, from 9:00 on days the store is open | `count`, `days` (the threshold), `oldestDays` | "**3 devices** have waited at Ready for pickup for over **7 days**" ("1 device has waited…" when 1) |
| `followup` | an Auto-Waymark follow-up is due today (one per work order per due date, from the follow-up hour) | `due` (`YYYY-MM-DD`), `kind` (`rfp`, `callback` or null) | "Follow-up due today on **700000003**" |
| `quiet` | no scan from the store for longer than the threshold of open-hours time; once per spell | `since` (ISO, the last scan), `hours` (the threshold) | "No updates from **Lynnhaven** since **1:40 PM** (store hours)" (format `since` in the store's zone) |
| `back` | scans resumed after a `quiet` alert; feed only, never notifies | `since` (the last scan before the silence), `resumedAt` | "Updates from **Lynnhaven** are back" (suggested wording; not in the mockups) |
| `digest` | the morning summary for **all** the phone's approved stores, once a day from the digest hour | see "Digest" below | Title "**Morning digest**"; body "**$3,400** yesterday · **3** ready for pickup · **2** stuck" (opens the Digest screen) |
| `unlinked` | Retrace: sales orders still without a work order for longer than the threshold; one alert per store per tick listing the new ones | `count`, `hours` (the threshold), `oldestHours`, `salesOrders` (the numbers, oldest first, at most 100) | "**2 sales orders** have no work order" ("1 sales order has no work order" when 1); expanded: the numbers |
| `coverage` | Retrace's coverage check stored a result with failures (count misses or missed items); one alert per result | `checkedAt` (ISO, the run), `countMisses`, `countItems`, `missedItems`, `qtyMisses`, `staleLabels` | "Coverage check: **3 items** short of labels, **2 items** missed" (leave out a zero part) |

Second line of every row in the mockups: `Store name #id · time of at` (e.g. "Lynnhaven #326 · 3:40 PM"). Tapping a work-order alert opens the work order (`wo`); `pickup` opens the store's Ready for pickup list; `quiet`/`back` open Home for that store.

Statuses: any open status except Ready for pickup (13) can be "stuck".

`unlinked` and `coverage` open Retrace for the store (`wo` is null). A digest's `store` is the first store of the phone's list (the row has to be filed under one); read `stores` instead.

### Digest

One entry a day for the phone's whole store list: a phone with 914 and 326 gets **one** combined digest, never one per store. `wo` is null.

```
{ "id": 530, "store": 326, "type": "digest", "wo": null, "at": "2026-10-15T12:00:00.000Z",
  "day": "2026-10-15", "yesterday": "2026-10-14", "stores": [326, 914],
  "sales": 3400, "splh": 170, "hours": 20, "target": [160, 180],
  "rfp": { "total": 300, "count": 3, "oldestDays": 12 },
  "followups": { "count": 3, "wos": [ { "store": 326, "wo": 303, "status": null }, { "store": 914, "wo": 301, "status": "Ready for pickup" },
                                      { "store": 914, "wo": 302, "status": "Diagnostics" } ] },
  "stuck": { "days": 3, "count": 2, "wos": [ { "store": 914, "wo": 101, "status": "Diagnostics", "days": 5 },
                                             { "store": 326, "wo": 102, "status": "Work in progress", "days": 4 } ] } }
```

- `day`: the store day it is for; `yesterday`: the day the sales numbers are about.
- `sales`, `splh`, `hours`: yesterday's sales, sales per labor hour and labor hours over the stores, by Home's rule (`GET /api/m/home`: sales of the stores that have hours that day ÷ their hours). `null` = no data (show a dash). `target`: the sales-per-labor-hour band, as on Home.
- `rfp`: now: Ready for pickup total in dollars, device count, oldest in whole days (`oldestDays` null when none). Same numbers as Home.
- `followups`: Auto-Waymark follow-ups due today (not removed, work order not closed): the count and up to 10 work orders (`status` null when the work order is not in the tracker).
- `stuck`: open work orders over the phone's own stuck threshold (`days`), any status except Ready for pickup: the count and up to 10, oldest first, with whole `days` in the status.

An `unlinked` entry:

```
{ "id": 531, "store": 914, "type": "unlinked", "wo": null, "at": "2026-10-15T16:00:00.000Z", "count": 2, "hours": 1, "oldestHours": 3, "salesOrders": ["FSO1001", "FSO1002"] }
```

A `coverage` entry:

```
{ "id": 532, "store": 914, "type": "coverage", "wo": null, "at": "2026-10-15T16:00:00.000Z", "checkedAt": "2026-10-15T15:55:00.000Z",
  "countMisses": 3, "countItems": 40, "missedItems": 2, "qtyMisses": 1, "staleLabels": 4 }
```

`countMisses`: baseline items with fewer labels stored than Portal counts (of `countItems` checked); `missedItems`: items the store's documents name that Retrace has no labels for; `qtyMisses` and `staleLabels` are the other two checks' counts, for context (they alone never raise the alert).

## Routes

### `GET /v1/agents/m/alerts` the feed

Query: `store=<id>|all` (default all of the phone's stores), `limit` (default 25, max 100), `before=<id>` (older page), `after=<id>` (only newer entries). Newest first. Read state and notify flags are this phone's.

```
{ "v": 1, "now": "2026-10-15T20:05:00.000Z", "cursor": 412, "unread": 2, "more": true, "next": 398,
  "alerts": [
    { "id": 412, "store": 914, "type": "stuck", "wo": 401, "at": "2026-10-15T15:00:00.000Z", "statusId": 9, "status": "Diagnostics", "days": 3,
      "since": "2026-10-12T14:54:59.000Z", "read": false, "notify": true },
    { "id": 411, "store": 326, "type": "quiet", "wo": null, "at": "2026-10-15T19:41:00.000Z", "since": "2026-10-15T17:40:00.000Z", "hours": 2,
      "read": true, "notify": false, "cleared": "2026-10-15T22:40:00.000Z" }
  ] }
```

- `cursor`: the newest alert id in the table; hand it to `/alerts/new?since=` (this is what the first run stores).
- `unread`: unread entries in this phone's feed, **counting only types and stores whose switch is on** (a switched-off type adds no badge but its entries stay in the list).
- `more` / `next`: when `more` is true, pass `before=<next>` for the next older page.
- `read`: read by this phone. `notify`: would raise a notification (unread, not a late "backfill" entry, not a `back` entry, type and store switches on). Quiet hours are not part of `notify` (see the poll). `cleared` (quiet alerts only): ISO time scans resumed, or null while the spell goes on.
- Entries are the phone's own threshold level only (see Thresholds). Digests are the phone's own store list and stuck threshold only. A feed filtered to one store (`store=<id>` on a phone with several stores) has no digests.

### `GET /v1/agents/m/alerts/new?since=<cursor>` the background poll

Designed for the 15-minute job: one small read, no writes.

```
GET …/alerts/new                    → { "v": 1, "cursor": 412, "alerts": [] }      first run: no `since`, answers the current cursor, no entries
GET …/alerts/new?since=398          → { "v": 1, "cursor": 412, "alerts": [ { "id": 411, "store": 326, "type": "quiet", "wo": null, "at": "…", "since": "…", "hours": 2 },
                                                                          { "id": 412, "store": 914, "type": "stuck", "wo": 401, "at": "…", "statusId": 9, "status": "Diagnostics", "days": 3, "since": "…" } ] }
GET …/alerts/new?since=412          → { "v": 1, "cursor": 412, "alerts": [] }
In quiet hours                      → { "v": 1, "cursor": 398, "alerts": [], "held": true }
More than 50 waiting                → { …, "cursor": <id of the 50th scanned>, "alerts": […], "more": true }     poll again straight away
```

Semantics:
- Entries are `id > since`, **oldest first**, only those that should notify now: unread on this phone, not late backfill, type and store switched on, at this phone's own threshold level, and raised less than **12 hours** ago. Entries that do not qualify are skipped but the cursor still moves past them.
- Store the returned `cursor` after raising the notifications. Idempotent: asking twice with the same `since` returns the same entries; asking with the new cursor returns none. A cursor never needs to be "acknowledged".
- **Quiet hours** (setting, store local time): while they are on, the poll answers `held: true`, no entries, and the **same cursor**. When quiet hours end the next poll returns everything that is still under 12 hours old (older entries stay in the feed). Keep the cursor as is when `held`.
- A cursor ahead of the table (after a database reset) is returned unchanged; `since` that is not a whole number is `400`.
- Alerts you already read (on this or another screen) are not returned.

**First run:** call `/alerts/new` without `since`, store the `cursor`, and start polling with it. Old alerts then do not all notify (a phone also starts with the history marked read: on the first call the server sets the read position to the newest alert, so the badge starts at 0 and only later alerts are unread).

### `POST /v1/agents/m/alerts/read`

`{ "ids": [412, 411] }` (1 to 100 ids) or `{ "all": true }` or `{ "all": true, "store": 914 }`. Ids of stores the phone is not approved for are ignored. Answer: `{ "ok": true, "unread": 0 }`. Idempotent. Read state is per phone: reading on one phone does not change another.

### `GET` / `PUT /v1/agents/m/alerts/settings`

```
GET → { "v": 1,
  "settings": { "types": { "stuck": { "on": true, "days": 3 }, "pickup": { "on": true, "days": 7 }, "followup": { "on": true, "hour": 9 }, "quiet": { "on": true, "hours": 2 },
                           "digest": { "on": true, "hour": 8 }, "unlinked": { "on": true, "hours": 1 }, "coverage": { "on": true } },
                "quietHours": { "on": true, "from": "22:00", "to": "07:00" },
                "stores": { "914": true, "326": true } },
  "stores": [914, 326],
  "ranges": { "stuckDays": [1, 30], "pickupDays": [1, 30], "quietHours": [1, 12], "followupHour": [0, 23], "digestHour": [0, 23], "unlinkedHours": [1, 48] },
  "defaults": { "types": { … }, "quietHours": { … } } }
```

`PUT` takes any part of `settings` (merged; body at most 2000 characters) and answers the same as `GET`:

```
PUT { "types": { "stuck": { "days": 5 }, "quiet": { "on": false } }, "quietHours": { "from": "21:30", "to": "06:00" }, "stores": { "326": false } }
```

| setting | meaning | range / default |
|---|---|---|
| `types.stuck.on` / `.days` | switch; more than this many days in one status | 1–30, default 3 |
| `types.pickup.on` / `.days` | switch; devices at Ready for pickup over this many days | 1–30, default 7 |
| `types.followup.on` / `.hour` | switch; local hour of day the follow-up alert is raised (shown as "9:00 AM") | 0–23, default 9 |
| `types.quiet.on` / `.hours` | switch; hours of silence during store open hours | 1–12, default 2 |
| `types.digest.on` / `.hour` | switch; local hour of day the morning digest is made (shown as "8:00 AM") | 0–23, default 8 |
| `types.unlinked.on` / `.hours` | switch; hours a Retrace sales order may stay without a work order | 1–48, default 1 |
| `types.coverage.on` | switch (no threshold) | default on |
| `quietHours.on` / `.from` / `.to` | no notifications between these store-local times (24-hour `"HH:MM"`, may cross midnight; `from` and `to` must differ) | on, 22:00 to 07:00 |
| `stores.<id>` | per-store switch (all approved stores default to true) | true / false |

Bad input is `400 {"error": "…"}` with the key and the range, e.g. `types.stuck.days: days must be a whole number from 1 to 30`, `unknown setting "types.stuck.day"` (typos are refused), `quietHours.from must be a time like "22:00" (24-hour, store local time)`, `quietHours.from and quietHours.to must differ`, `types.unlinked.hours: hours without a work order must be a whole number from 1 to 48`, `unknown setting "types.coverage.hours"`. A store that is not the phone's is `403 not your store`; a body over 2000 characters `413`; bad JSON `400`.

The `quiet` type's switch also governs its `back` entries. Store switches do not apply to the digest (it covers all the phone's stores); turn it off with `types.digest.on`. Stores are all in the zone `STORE_TZ` (America/New_York); the phone should show times in that zone, like Home.

## Thresholds are per phone

The rules run once per store; thresholds belong to each phone. The server raises an alert for every **distinct threshold** among the store's approved phones (normally one, the default), stamping it with that value as its `level`. A phone's feed and poll contain only alerts at its own level for each type. So a phone with "stuck after 5 days" gets its alert when a work order reaches 5 days, while another phone with 3 days got its own at 3; neither sees the other's. The digest's level is its hour, and it is also keyed by the phone's store list and stuck threshold: phones with the same stores and stuck threshold share one digest. A phone that changes a threshold sees the history of its new level (alerts at the old level stay stored but are not in its feed). When a phone raises a threshold, the server has not raised alerts at that level yet, so nothing old notifies; when it lowers one, work orders already past it appear in the feed and are marked late (never notify).

## What the rules do (exact)

All "longer than" tests are strictly greater; "now" is the tick time; the tick runs every 10 minutes (cron `*/10 * * * *`) for every store that has at least one approved phone.

- **stuck**: open work order (`workorders.is_open = 1`) whose open `status_periods` row (`end_at IS NULL`) matches its current status, status not 13, with `now - start_at > days`. A work order with no known status start has no period row, so it never alerts. De-duplication: one alert per status period and level; leaving the status and being stuck again alerts again (an alert created after the period began counts as the same period, so a start time that the status history later shifts does not repeat it). If a work order was already more than 1 hour past its threshold when first seen (first tick after a phone is approved, a missed tick, a lowered threshold) the alert is marked late: it is in the feed, never a notification.
- **pickup**: `rfp_periods` rows still open (`end_at IS NULL`) older than `days`, counted per store; from 9:00 local on days the store is open (`hoursFor`); once per store, level and local day. Same source as the RFP ages on Home.
- **followup**: Waymark database `auto_marks` rows with `due` = today (store day), not removed, work order not closed (`wo_closed`), from the phone's follow-up hour; once per work order, due date and level.
- **quiet**: the store's latest scan is older than `hours` of **open-hours time** (night, closed days and closing hours do not count; Lexington is open every day) and the store is open now; once per spell (key: the last scan's time). When a newer scan appears the spell is closed (`cleared` set) and one `back` entry is added (feed only).
- **digest**: from the phone's digest hour (store local time) on, every day, one per scope (sorted store list + stuck threshold) and hour; key `"<stores>|<stuck days>@<day>"`. Worked out only for phones with the digest switched on (the one exception to "switches apply on read": its facts cost reads). Made more than 1 hour after its hour (switched on late, a phone approved in the afternoon, a missed tick) it is late (feed only). Quiet hours work as for every alert: a digest at 8:00 with quiet hours ending 7:00 notifies at once; a digest at 6:00 with quiet hours to 7:00 is held and comes out at 7:00.
- **unlinked**: Retrace's `inv_so_need` rows (sales orders the collector was asked about) with no `inv_so_wo` link; age = now − the sales order's first movement (`inv_movements`, `ref_type = 'sales_order'`), strictly greater than `hours`. Per store and level, one alert per tick listing the newly crossed ones (at most 100; key: the first sales order's number). Each sales order is remembered per level (`alert_items`) so it **never alerts again**, even after retention deletes its alert; the hourly housekeeping forgets it once it has a work order or has left Retrace's list. An alert whose sales orders are all more than 1 hour past the threshold (first sight after deploy, a lowered threshold) is late (feed only).
- **coverage**: the store's stored coverage result (`inv_verify`, one per store, replaced by each run) with `counts.n > 0` or `missed.n > 0`; one alert per result (key: `checked_at`). Results older than 60 days are ignored; a result first seen more than 1 hour after its run is late (feed only).
- Per tick, at most **25** alerts per store are created (oldest condition first, the rest on the next ticks).
- Retention: alerts older than **60 days** are deleted by the hourly housekeeping (the tick at minute :00–:09), with the read marks that point at them and the settings of phones that no longer exist.

## Cost of a tick

For a store with about 80 open work orders (measured in the tests): the whole tick is 1 statement to list approved phones plus per store 1 (stuck) + 1 (pickup) + 2 (last scan and open quiet spell, one batch), and one read of Waymark's database for all stores (only from the earliest follow-up hour on). Two stores and four phones: 11 tracker statements (unlinked and coverage are one statement each for all stores; the digest adds one look-up per tick when on), 16 in the hourly housekeeping tick. With 200 sales orders on Retrace's list (half linked, half already alerted) the unlinked read is about 700 rows (key look-ups; the first-movement time is read only for sales orders not yet alerted); coverage reads one row per store. The tick that makes a digest runs Home's numbers for the scope (about 34 statements in the tests), once a day per scope. The stuck statement reads about 240 rows (the store's open status periods, their work orders, statuses, and alert look-ups) and writes nothing in the steady state; the pickup statement about 40 rows for 20 devices at Ready for pickup. With no approved phone a tick is one statement. Writes happen only when an alert is created.

A poll (`/alerts/new`) is 2 statements (the phone's state row, then one indexed read) and no writes. The first call from a phone writes its state row.

## Notification suggestions

- Channels by type (Stuck work orders, Waiting for pickup, Follow-up due, Store gone quiet, Morning digest, Sales orders without a work order, Coverage check) so Android settings mirror the in-app switches.
- Group by store (`setGroup("store-914")`) with a summary per store; when several alerts of one type arrive in one poll for one store (for example many stuck work orders), collapse them into one line ("4 work orders stuck in a status").
- Text = the sentence above; tag = the alert `id`; tapping marks read (`POST …/read {ids:[id]}`) and opens the target. Never include anything but the work order number and status in a notification.
- Show `unread` from the feed as the Alerts tab badge (it already respects switches).
- Do not poll faster than every 15 minutes in the background; the server's data only changes every 10 minutes.

## Deploy (not done)

1. `cd tracker-worker && npx wrangler d1 execute aethernet-tracker --remote --file=migrations/2026-11-13-mobile-alerts.sql` (idempotent, additive; after `2026-11-13-mobile-devices.sql`), then the same with `--file=migrations/2026-11-16-mobile-alerts-items.sql` (one new table, for `unlinked`).
2. Deploy the tracker Worker (the 10-minute cron is already in `wrangler.toml`).
