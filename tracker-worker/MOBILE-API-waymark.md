# Linkpearl phone API: Waymark (`/v1/agents/m/waymark…`)

Source: `src/mobile-waymark.js` (`waymarkApi`), tests: `test/mobile-waymark.test.mjs` (the JSON below is real output from that test; store and work order numbers are invented).
Auth as for every `/v1/agents/m/…` route (app key header + `Authorization: Bearer <id>.<token>`, approved phone; a Mac agent gets `403 not a phone`, a pending phone `403 not approved yet`). Reading tags and follow-ups is part of the work order routes (`tags`, `followUp` on open-list rows and the detail, `MOBILE-API-wo.md`); these routes change them. No storage of their own (no migration): they write Waymark's own tables (`env.AE`, `worker/schema.sql`).

## What is written, and by whom

The writes are the Waymark Worker's own (`worker/src/index.js`: `/wo/:wo/tag`, `/untag`, `/push`, `/unmark`): the same statements on `wo_tags`, `auto_marks`, `wo_closed` and `history`, the same history rows, so Portal's tag chips, board, history popover and Auto-Waymark chip show a phone's change exactly like one made in Portal.

- **Author**: `Linkpearl (<device name>)` (the name on the admin page and in prefs), `by_id` NULL, in `wo_tags.by_name` and `history.by_name`. A staff name never comes from the phone: any `by` / `byId` in a body is ignored.
- **History rows** (Waymark's log): tag on `add` (tag), tag off `remove` (tag), push `push` (detail `"2026-11-15 → 2026-11-19"`), remove `unmark` (detail = the old due). A tag that was already on (or already off) writes no history row.
- **Tracker access log**: every accepted write is an `access_log` row, actor `device:<name>`, action `waymark:tag` | `waymark:untag` | `waymark:push` | `waymark:unmark`, with store, work order and a short detail (the tag, or `old -> new`, plus the first 8 characters of the device id).
- **Limit**: 120 accepted writes per phone per hour (counted from those log rows), then `429 {"error":"too many Waymark changes from this phone, try again later"}`. Reads are not counted.

Checks on every route: `store` must be one of the phone's approved stores (`403 not your store`) and have Aethernet access in Waymark (`403 this store does not have access to Aethernet`, as Waymark's own Worker refuses it). On writes, `wo` must be a work order the tracker holds in that store (`404 no such work order`; `400 wo required` for anything but a 5 to 12 digit number). `store` and `wo` may be numbers or digit strings. Body over 2000 characters: `413`; not a JSON object: `400`.

## `GET /v1/agents/m/waymark/tags?store=<id>`

The store's managed tag list, in the store's order, for the tag sheet.

```json
{"v":1,"store":914,"tags":[{"name":"Priority","color":"red"},{"name":"Waiting on customer","color":"orange"},{"name":"Parts","color":"blue"}],"oneOff":true,"maxTags":12,"maxLength":32}
```
- `color`: Waymark's colour names (`purple`, `blue`, `teal`, `green`, `lime`, `yellow`, `orange`, `red`, `grey`), the same as `tags[].color` on work order rows. A store with no list: `"tags":[]`.
- `oneOff: true`: Waymark lets everyone add free-text tags to a work order (only the managed list itself is limited to managers, and the phone cannot change it). Show a text box under the list.
- `maxTags`: tags one work order can carry; `maxLength`: characters in a tag (longer text is cut).
- Errors: `400 store required`, `403` as above. Other methods `405`.

## `POST /v1/agents/m/waymark/tag`

Body `{ "store": 914, "wo": 8000001, "tag": "Priority", "on": true }` (`on: false` takes it off).

```json
{"ok":true,"store":914,"wo":8000001,"tag":"Priority","on":true,"changed":true,"tags":[{"tag":"Priority","color":"red"}]}
{"ok":true,"store":914,"wo":8000001,"tag":"Call back after 3 xxxxxxxxxxxxxx","on":false,"changed":true,"tags":[{"tag":"Priority","color":"red"}]}
```
- `tag` is cleaned the way Waymark cleans it (control characters removed, whitespace collapsed, trimmed, cut to 32 characters); the answer's `tag` is what was actually used. A tag that matches a managed tag apart from capitals ("priority") is that managed tag ("Priority"); anything else is a one-off (`color: null`).
- `changed: false` when it was already on (or already off): not an error, nothing written to Waymark's history.
- `tags`: the work order's tags afterwards, oldest first, the same shape as on work order rows. No authors.
- Adding a tag to a work order Waymark had recorded as closed takes it off Waymark's closed list (Waymark's own rule: "tagged again = still in play").
- Errors: `400 on: true or false`, `400 tag required`, `400 too many tags on this work order` (12; re-adding one that is already on is fine), `409 work order is closed` (adding to a work order the tracker has closed; taking a tag off a closed one is allowed).

## `POST /v1/agents/m/waymark/followup`

Move the follow-up later: `{ "store": 914, "wo": 8000001, "due": "2026-11-19" }`

```json
{"ok":true,"store":914,"wo":8000001,"followUp":{"kind":"rfp","due":"2026-11-19"}}
```
Remove it for good: `{ "store": 914, "wo": 8000001, "remove": true }`

```json
{"ok":true,"store":914,"wo":8000001,"followUp":null}
```
- **Later only**: `due` (store-local `YYYY-MM-DD`, a real date) must be after the current due date (`400 follow-ups can only move later`), as Waymark's Worker requires. Offer the rule's quick choices (Ready for pickup +3 / +1 / +7 days, Awaiting callback +1 / +3 / +7, from today) and a date picker that starts the day after the current due. At most a year after today (`400 due: at most a year ahead`).
- **Remove** is Portal's ×: the row stays with `removed_at`, so Auto-Waymark never re-creates it while the work order stays in that status; it starts fresh only if the work order leaves the status and comes back. It cannot be undone from the phone.
- `kind` is kept (`rfp` = Ready for pickup, `callback` = Awaiting callback or device).
- **No creating**: a phone cannot add a follow-up where there is none (or where one was removed). Waymark creates them only from Portal statuses (Auto-Waymark), never by hand, so `404 no follow-up on this work order`. Hide the push and remove actions when the row's `followUp` is null.
- The work order must be open in the tracker: `409 work order is closed`.
- `409 the follow-up changed meanwhile, reload it`: someone moved or removed it between the read and the write; reload the work order and try again.
- Errors also: `400 due: YYYY-MM-DD`, `400 due or remove: true (one of them)`, `400 remove: true`.

## Portal's device nickname

In Portal a follow-up's date is mirrored into the device nickname (`M/DD`; at Awaiting callback the date is replaced or added at the end). This Worker cannot reach Portal, so a phone push does not rename the device at once. The userscript's Waymark scan (every 10 minutes, in one open Portal tab per browser, at any store that has Portal open) compares each marked work order's nickname with its mark and rewrites it (`planScan` → `rename` → `syncNickname`), so the nickname follows a phone push within about 10 minutes of a Portal tab being open. A date in the nickname that is LATER than the mark moves the mark instead, so a push is never undone by an older nickname. Removing a follow-up leaves the nickname's date alone, exactly as Portal's × does.
