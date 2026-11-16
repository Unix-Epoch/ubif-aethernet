# Linkpearl phone API: Trends (`/v1/agents/m/trends`)

Source: `src/mobile-trends.js`, tests: `test/mobile-trends.test.mjs` (the JSON below is real output from that test; every number is invented).
Auth as for every `/v1/agents/m/…` route (app key header + `Authorization: Bearer <id>.<token>`, approved phone). A Mac agent gets `403 not a phone`; a pending phone `403 not approved yet`. Read only, no storage of its own (no migration). No customer or staff names in any answer.

## `GET /v1/agents/m/trends?store=<id>|all&period=week|month|year&at=YYYY-MM-DD[&fresh=1]`

| Parameter | Default | Meaning |
|---|---|---|
| `store` | `all` | One approved store, or `all` (the phone's approved stores only). A store that is not approved: `403 {"error":"not your store"}`; anything else that is not a number: `400`. |
| `period` | `week` | `week`, `month` or `year`; anything else `400`. |
| `at` | today | Any day inside the wanted period, a **store day** (`tz`). Not a real date: `400 {"error":"at: a day YYYY-MM-DD"}`; a period that starts after today: `400 {"error":"at: a day up to today"}`. To page back, send the day before `from`. |
| `fresh` | | `1` skips the 60-second server cache (manual refresh only), like Home. |

**Periods** are calendar periods in store time:
- **Week = Sunday through Saturday** (Portal's own week: its time sheet ranges start on a Sunday). Home's 7-day chart is a rolling window ending today; a rolling window can't be paged back period by period, so Trends uses calendar weeks. This week in Trends is therefore not Home's 7 days.
- **Month** = the calendar month; **Year** = the calendar year, charted in **12 monthly buckets**.
- The previous period is the calendar period right before (last week, last month, last year).

```json
{"v":1,"period":"week","scope":"all","tz":"America/New_York","today":"2026-11-16",
 "from":"2026-10-11","to":"2026-10-17","prevFrom":"2026-10-04","prevTo":"2026-10-10","prevThrough":"2026-10-10",
 "asOf":"2026-10-15T19:10:00.000Z",
 "sales":{"total":380,"prevTotal":1179,"changePct":-67.8,
   "days":[{"day":"2026-10-11","value":null},{"day":"2026-10-12","value":200},{"day":"2026-10-13","value":120},{"day":"2026-10-14","value":null},{"day":"2026-10-15","value":60},{"day":"2026-10-16","value":null},{"day":"2026-10-17","value":null}],
   "prevDays":[{"day":"2026-10-04","value":null},{"day":"2026-10-05","value":100},{"day":"2026-10-06","value":50},{"day":"2026-10-07","value":null},{"day":"2026-10-08","value":30},{"day":"2026-10-09","value":999},{"day":"2026-10-10","value":null}]},
 "splh":{"value":15.79,"prev":50,"hours":19,"target":{"lo":160,"hi":180},
   "days":[{"day":"2026-10-11","value":null},{"day":"2026-10-12","value":20},{"day":"2026-10-13","value":8},{"day":"2026-10-14","value":null},{"day":"2026-10-15","value":15},{"day":"2026-10-16","value":null},{"day":"2026-10-17","value":null}]},
 "cleaning":{"linked":6,"orders":10,"pct":60,"prevPct":28.6},
 "rfp":{"total":30,"count":1,"prevTotal":null},
 "stores":[{"id":914,"name":"Newport News","sales":340,"prevSales":1179,"changePct":-71.2,"splh":18.57,"hours":14},
           {"id":326,"name":"Lynnhaven","sales":40,"prevSales":null,"changePct":null,"splh":8,"hours":5}]}
```

Fields (money in dollars, 2 decimals; `null` = no data, show a dash, never 0):
- `scope`: the store id, or `"all"`. `today`: the store day now. `from`/`to`: the chosen period (`to` may be in the future). `prevFrom`/`prevTo`: the whole previous period. **`prevThrough`**: the last previous-period day counted in the `prev…` figures (below). `asOf`: the last store scan, the oldest across the stores (Home's `asOf`), or null.
- **Comparison rule.** While the chosen period is running, every `prev…` figure (`sales.prevTotal`, `splh.prev`, `cleaning.prevPct`, `stores[].prevSales`) covers the previous period **up to the same point**: through the matching day, inclusive (week: same weekday; month: same day of the month, clamped to the shorter month, so Mar 31 → Feb 28; year: same month and day). Example: on Nov 15, month = Nov 1–15 against Oct 1–15. The granularity is a day, so today's partial day is compared with that whole day. A period that is over is compared with the whole previous period (`prevThrough = prevTo`).
- `sales`: `total` = the period so far; `changePct` = `(total − prevTotal) ÷ prevTotal × 100`, 1 decimal, null when either side is null or `prevTotal` is 0. `days` = one entry per day (`day` = `YYYY-MM-DD`) for week and month, one per month (`day` = `YYYY-MM`) for year; future days and months are null. `prevDays` = the previous period aligned by position (`prevDays[i]` is its i-th day or month), shown **whole** (it is the comparison line; only `prevTotal` stops at `prevThrough`). In a month view the two arrays can differ in length (31 vs 30 days). Sales are Home's: Portal's sales where the day was synced, else estimated from work orders at Sale complete (`buildMetrics`, the Metrics page's own function); a day is null unless it was synced or has estimated sales. A bucket is the sum of its known days, null when none is known.
- `splh`: sales per labor hour by the Metrics rule: sales of the store-days that have labor hours ÷ those hours (days with hours but no sales, and stores without hours, are left out; not an average of ratios). `hours` = the labor hours behind `value`. `prev` = the same for the previous period through `prevThrough`. `target` = Home's band (`SPLH_TARGET`, `{lo:160,hi:180}`). `days` = per bucket, like `sales.days`.
- `cleaning`: Home's cleaning card over the period: `linked` cleanings ÷ Asurion Mobility `orders` (`cleanings_linked` ÷ `am_orders` from the daily uploads), only days with orders > 0. `pct` and `prevPct` are **percent** (60 = 60%, 1 decimal, can exceed 100); all null without orders.
- `rfp`: devices on the Ready for pickup table and their value (cart value before tax, last seen while in RFP) **at the end of the period**: `total` and `count` at the end of the chosen period, or **now** while it is running (then the same total as Home's `rfp.total`); `prevTotal` at the end of the previous period (11:59:59 PM store time on `prevTo`, not "the same point"). Rebuilt from `rfp_periods`, the record Tactician's "RFP table at the end of a day" uses. **History limit:** `rfp_periods` started recording on Oct 12, 2026 and was never backfilled, so an end-of-period value before **Oct 13, 2026** (`RFP_SINCE`), or before the first scan of any store in scope, can't be computed honestly and is `null` (`total`/`count` of a past period, and `prevTotal`).
- `stores` (only when `store=all`): one row per approved store, in approval order: `sales`, `prevSales` (through `prevThrough`), `changePct`, `splh`, `hours` as above; `name` can be null. Absent for one store.
- No stores approved: `200 {"v":1,"stores":[],"empty":true}`.

Caching: `cache-control: private, max-age=60`, and a 60-second server cache per (stores, period, store day) like Home's; `fresh=1` skips the read. Cost: one Metrics build over the previous and current periods (a year view reads two years), so fetch a period only when it is shown and poll no faster than Home. About 1.7 KB for a week of All stores.

Other methods and sub-paths (`/trends/…`): `404`.
