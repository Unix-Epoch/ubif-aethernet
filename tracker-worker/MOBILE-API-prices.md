# Linkpearl phone API: prices (`/v1/agents/m/prices`)

Source: `src/mobile-prices.js`, tests: `test/mobile-prices.test.mjs` (the JSON below is real output from that test, on the invented sheet in `test/fixtures/prices/price-sheet.json`).
Auth as for every `/v1/agents/m/…` route (app key header + `Authorization: Bearer <id>.<token>`, approved phone). Read only, one store per request, no customer data.

The sheet is the store's Price sheet as `sheets/sync_sheets.py` pushes it (Waymark's database, table `sheets`, kind `prices`; the userscript reads the same row through the Aethernet Worker's `GET /v1/:store/sheets/prices`). Only store 914 has one today; any other approved store answers `syncedAt: null` with nothing listed. Matching is a port of the userscript's `src/23-price-sheet.js` (Provoke, Reassemble), and the test runs both on the same sheet and requires the same rows and prices:

- Only the retail tabs are read: `Apple`, `Samsung`, `Google`, `ipad`, `Game Console` (Refurb, BER and the rest are synced but never quoted).
- A device matches a row by its exact model words, brand words dropped (`Apple`, `Samsung`, `Galaxy`, `5G`…), `+` read as `plus`, brackets ignored. Extra words after the model are fine (`iPhone 15 Pro Max 256GB`), but a shorter row never stands in for a longer model (`iPhone 15 Pro` row, `iPhone 15 Pro Max` asked: no match).
- A row named `iPhone 6/6S` answers for both. Rows ending `Inner` / `Outer` are two variants of one device (both are returned).
- A price is the first number in the cell (`$190 (MS)` → 190); a cell saying `N/A` or `… self repair`, or with no number, has `price: null`.

## `GET /v1/agents/m/prices?store=<id>`: the device list

For search-as-you-type on the phone: every quotable device, in sheet order, one entry per `key` (shortened here).

```json
{"store":914,"syncedAt":"2026-11-14T13:00:00.000Z",
 "devices":[{"key":"iphone15promax","name":"iPhone 15 Pro Max","tab":"Apple"},{"key":"iphone15pro","name":"iPhone 15 Pro","tab":"Apple"},
            {"key":"iphone15","name":"iPhone 15","tab":"Apple"},
            {"key":"iphone6","name":"iPhone 6","tab":"Apple"},{"key":"iphone6s","name":"iPhone 6S","tab":"Apple"},
            {"key":"zfold5","name":"Galaxy Z Fold 5","tab":"Samsung"},{"key":"ipad9thgen","name":"iPad 9th Gen (10.2)","tab":"ipad"},
            {"key":"ps5","name":"Sony PS5","tab":"Game Console"}, …]}
```
- `key`: the model words run together; sending it back as `q` finds exactly that device. `name`: the row's name for display (a note after it, Inner/Outer, and the other half of an `a/b` row removed). Both `key` and `name` work as `q`.
- `syncedAt`: when the sync job last pushed the sheet (ISO UTC), or null when the store has no sheet (`devices: []`).

## `GET /v1/agents/m/prices?store=<id>&q=<device text>`: one device's prices

```json
{"store":914,"syncedAt":"2026-11-14T13:00:00.000Z",
 "matches":[{"name":"iPhone 15 Pro","tab":"Apple","variant":null,
   "repairs":[{"repair":"Screen","label":"Screen","price":329.99,"raw":"$329.99"},
              {"repair":"Screen","label":"OEM","price":null,"raw":"N/A"},
              {"repair":"Battery","label":"Battery","price":null,"raw":"Apple self repair"},
              {"repair":"Charge port","label":"Charging Port","price":149.99,"raw":"$149.99"},
              {"repair":"Back glass","label":"Back Glass","price":190,"raw":"$190 (MS)"}]}]}
```
Inner/Outer (`q=zfold5`):
```json
{"store":914,"syncedAt":"2026-11-14T13:00:00.000Z",
 "matches":[{"name":"Galaxy Z Fold 5 Inner","tab":"Samsung","variant":"inner","repairs":[{"repair":"Screen","label":"OLED","price":549.99,"raw":"$549.99"},{"repair":"Battery","label":"Battery","price":129.99,"raw":"$129.99"}]},
            {"name":"Galaxy Z Fold 5 Outer","tab":"Samsung","variant":"outer","repairs":[{"repair":"Screen","label":"OLED","price":219.99,"raw":"$219.99"}]}]}
```
- `matches`: the matching rows (usually one; two for Inner/Outer), `[]` when nothing matches or the store has no sheet. `name` is the row's full name as on the sheet. `variant`: `"inner"`, `"outer"` or null.
- `repairs`, per sheet column (the `Notes` column left out), in this order:
  1. `repair` = `Screen`, `Battery`, `Charge port` or `Back glass` when the column is one of those (the userscript's Reassemble mapping, tried in that order: Screen = a column matching `lcd|oled|oem|octa|ub screen|screen repair|^glass$|glass/lcd` and not `back|camera|cam\b|housing`; Battery = `battery`; Charge port = `charge|charging|dock`; Back glass = `back glass`, all case-insensitive). These are listed even when unpriced (`price: null`, show `raw`), so a row can have several Screen entries (e.g. `Screen` and `OEM`).
  2. then every other column that has a price, with `repair` = the column's own name (e.g. `Back Camera`, `HDMI / RETIMER`).
  Within each, sheet column order. `label` is the column name (`Screen Repair` shortened to `Screen`); `raw` the cell text as synced; `price` a number in dollars or null.
- `q` is trimmed and cut to 80 characters; a blank `q` is the device list.

## Errors

`store` missing or not a number: `400 {"error":"store: a store number"}`; a store the phone is not approved for: `403 {"error":"not your store"}`; other methods `405`; any sub-path (`/prices/914`) `404`. A sheet row that is not valid JSON reads as an empty sheet (its `syncedAt`, nothing listed), never a 500.

## Notes

- No real sample of the Price sheet is in the repo: the column names in the fixture (`Screen Repair`, `OEM`, `OLED`, `Glass/LCD`, `LCD`, `Glass`, `Battery`, `Charging Port`, `Charge Port`, `Dock Port`, `Back Glass`, `Back Camera`, `Camera Lens`, `Camera Glass`, `HDMI / RETIMER`, `HDD 500GB`, `Disc Drive`, `Notes`) are built from the parser's own regexes and the sync job's comments; the code reads whatever columns the sheet has.
- The parsed sheet is cached per isolate until the sync job pushes a new one (`synced_at` changes), so a request costs one small D1 read.
- The phone should cache the device list and refresh it when `syncedAt` changes.
