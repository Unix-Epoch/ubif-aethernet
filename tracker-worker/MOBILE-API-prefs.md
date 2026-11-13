# Linkpearl phone API: settings (`/v1/agents/m/prefs…`)

Source: `src/mobile-prefs.js`, tests: `test/mobile-prefs.test.mjs` (the JSON below is real output from that test; ids and fingerprint are from a throwaway test phone).
Auth as for every `/v1/agents/m/…` route (app key header + `Authorization: Bearer <id>.<token>`, approved phone). Every route acts on the calling phone only: the device comes from the token, no route takes a device id. A Mac agent gets `403 not a phone`; a pending phone `403 not approved yet`. No customer or staff names in any answer. No storage of its own (no migration).

## `GET /v1/agents/m/prefs`

```json
{"v":1,
 "device":{"id":"a08af12d1cc71c6559e5de5405a84c4a","name":"Pixel Fold","kind":"phone","fingerprint":"BE12-2440-5B95-C3D8"},
 "stores":[{"id":326,"name":"Lynnhaven","lastScanAt":null},{"id":914,"name":"Newport News","lastScanAt":"2026-11-13T16:12:00.000Z"}],
 "now":"2026-11-13T17:10:46.725Z",
 "minApp":{"code":1,"name":"0.1.0"}}
```
- `device.fingerprint`: the one the admin site shows next to this phone.
- `stores`: the approved stores only, by id; `name` can be null; `lastScanAt` is the newest tracker scan of that store (ISO UTC) or null (show a dash).
- `now`: server time, ISO UTC.
- `minApp`: the oldest app the server accepts (`code` = Android `versionCode`). A constant for now (`MIN_APP`); raise it in the same deploy as a breaking change and have the app show an update notice when its own code is lower.
- Other methods: `405`. Unknown sub-path: `404`.

## `POST /v1/agents/m/prefs/name`

Body `{"name":"Pixel Fold"}` → `200 {"ok":true,"name":"Pixel Fold"}`. Validated like registration: control characters stripped, whitespace collapsed and trimmed, 60 characters at most; empty or non-string: `400 {"error":"name required"}`; body over 1000 characters: `413`. The admin site shows the new name. Written to the access log as `device:rename`.

## `POST /v1/agents/m/prefs/forget`

No body → `200 {"ok":true}`. The phone revokes itself with the same statements the admin site's Remove runs (`agent_keys` rows, the `agents` row and its `agent_kind` row are deleted): the token stops working at once, so every later call, including `/v1/agents/me`, answers `401 {"error":"unknown program or wrong token"}`, and the wrapped store keys are gone. The app then deletes its own token, key and stored state and shows registration. Logged as `device:forget`. Paths with an id (`/forget/<id>`) are `404`.
