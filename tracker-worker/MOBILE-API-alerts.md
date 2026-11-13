# Linkpearl alerts API

Part of the phone API (`MOBILE-API.md`: same app key, same `Authorization: Bearer <id>.<token>`, same error shape `{ "error": "…" }`). Code: `src/mobile-alerts.js`, tests: `test/mobile-alerts.test.mjs`, storage: `migrations/2026-11-13-mobile-alerts.sql`.

There is **no push service**. The server evaluates rules every 10 minutes and keeps a feed of alerts. The app's background check (WorkManager, about every 15 minutes) asks `GET /v1/agents/m/alerts/new?since=<cursor>` and raises local notifications itself. Every route is limited to the phone's approved stores (`/me` → `stores`). A store outside them is `403 {"error":"not your store"}` where a store can be named. `/v1/agents/m/push…` answers `404` (no push service).

No alert ever carries a customer name, phone, e-mail, IMEI or a staff name. Facts are numbers, a status name, times and a due date. Work order numbers are the only identifiers.

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

Second line of every row in the mockups: `Store name #id · time of at` (e.g. "Lynnhaven #326 · 3:40 PM"). Tapping a work-order alert opens the work order (`wo`); `pickup` opens the store's Ready for pickup list; `quiet`/`back` open Home for that store.

Statuses: any open status except Ready for pickup (13) can be "stuck".

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
- Entries are the phone's own threshold level only (see Thresholds).

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
  "settings": { "types": { "stuck": { "on": true, "days": 3 }, "pickup": { "on": true, "days": 7 }, "followup": { "on": true, "hour": 9 }, "quiet": { "on": true, "hours": 2 } },
                "quietHours": { "on": true, "from": "22:00", "to": "07:00" },
                "stores": { "914": true, "326": true } },
  "stores": [914, 326],
  "ranges": { "stuckDays": [1, 30], "pickupDays": [1, 30], "quietHours": [1, 12], "followupHour": [0, 23] },
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
| `quietHours.on` / `.from` / `.to` | no notifications between these store-local times (24-hour `"HH:MM"`, may cross midnight; `from` and `to` must differ) | on, 22:00 to 07:00 |
| `stores.<id>` | per-store switch (all approved stores default to true) | true / false |

Bad input is `400 {"error": "…"}` with the key and the range, e.g. `types.stuck.days: days must be a whole number from 1 to 30`, `unknown setting "types.stuck.day"` (typos are refused), `quietHours.from must be a time like "22:00" (24-hour, store local time)`, `quietHours.from and quietHours.to must differ`. A store that is not the phone's is `403 not your store`; a body over 2000 characters `413`; bad JSON `400`.

The `quiet` type's switch also governs its `back` entries. Stores are all in the zone `STORE_TZ` (America/New_York); the phone should show times in that zone, like Home.

## Thresholds are per phone

The rules run once per store; thresholds belong to each phone. The server raises an alert for every **distinct threshold** among the store's approved phones (normally one, the default), stamping it with that value as its `level`. A phone's feed and poll contain only alerts at its own level for each type. So a phone with "stuck after 5 days" gets its alert when a work order reaches 5 days, while another phone with 3 days got its own at 3; neither sees the other's. A phone that changes a threshold sees the history of its new level (alerts at the old level stay stored but are not in its feed). When a phone raises a threshold, the server has not raised alerts at that level yet, so nothing old notifies; when it lowers one, work orders already past it appear in the feed and are marked late (never notify).

## What the rules do (exact)

All "longer than" tests are strictly greater; "now" is the tick time; the tick runs every 10 minutes (cron `*/10 * * * *`) for every store that has at least one approved phone.

- **stuck**: open work order (`workorders.is_open = 1`) whose open `status_periods` row (`end_at IS NULL`) matches its current status, status not 13, with `now - start_at > days`. A work order with no known status start has no period row, so it never alerts. De-duplication: one alert per status period and level; leaving the status and being stuck again alerts again (an alert created after the period began counts as the same period, so a start time that the status history later shifts does not repeat it). If a work order was already more than 1 hour past its threshold when first seen (first tick after a phone is approved, a missed tick, a lowered threshold) the alert is marked late: it is in the feed, never a notification.
- **pickup**: `rfp_periods` rows still open (`end_at IS NULL`) older than `days`, counted per store; from 9:00 local on days the store is open (`hoursFor`); once per store, level and local day. Same source as the RFP ages on Home.
- **followup**: Waymark database `auto_marks` rows with `due` = today (store day), not removed, work order not closed (`wo_closed`), from the phone's follow-up hour; once per work order, due date and level.
- **quiet**: the store's latest scan is older than `hours` of **open-hours time** (night, closed days and closing hours do not count; Lexington is open every day) and the store is open now; once per spell (key: the last scan's time). When a newer scan appears the spell is closed (`cleared` set) and one `back` entry is added (feed only).
- Per tick, at most **25** alerts per store are created (oldest condition first, the rest on the next ticks).
- Retention: alerts older than **60 days** are deleted by the hourly housekeeping (the tick at minute :00–:09), with the read marks that point at them and the settings of phones that no longer exist.

## Cost of a tick

For a store with about 80 open work orders (measured in the tests): the whole tick is 1 statement to list approved phones plus per store 1 (stuck) + 1 (pickup) + 2 (last scan and open quiet spell, one batch), and one read of Waymark's database for all stores (only from the earliest follow-up hour on). Two stores and three phones: 9 tracker statements, 13 in the hourly housekeeping tick. The stuck statement reads about 240 rows (the store's open status periods, their work orders, statuses, and alert look-ups) and writes nothing in the steady state; the pickup statement about 40 rows for 20 devices at Ready for pickup. With no approved phone a tick is one statement. Writes happen only when an alert is created.

A poll (`/alerts/new`) is 2 statements (the phone's state row, then one indexed read) and no writes. The first call from a phone writes its state row.

## Notification suggestions

- Channels by type (Stuck work orders, Waiting for pickup, Follow-up due, Store gone quiet) so Android settings mirror the in-app switches.
- Group by store (`setGroup("store-914")`) with a summary per store; when several alerts of one type arrive in one poll for one store (for example many stuck work orders), collapse them into one line ("4 work orders stuck in a status").
- Text = the sentence above; tag = the alert `id`; tapping marks read (`POST …/read {ids:[id]}`) and opens the target. Never include anything but the work order number and status in a notification.
- Show `unread` from the feed as the Alerts tab badge (it already respects switches).
- Do not poll faster than every 15 minutes in the background; the server's data only changes every 10 minutes.

## Deploy (not done)

1. `cd tracker-worker && npx wrangler d1 execute aethernet-tracker --remote --file=migrations/2026-11-13-mobile-alerts.sql` (idempotent, additive; after `2026-11-13-mobile-devices.sql`).
2. Deploy the tracker Worker (the 10-minute cron is already in `wrangler.toml`).
