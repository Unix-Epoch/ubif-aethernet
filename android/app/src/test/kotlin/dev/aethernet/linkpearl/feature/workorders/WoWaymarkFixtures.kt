package dev.aethernet.linkpearl.feature.workorders

/** Responses copied from tracker-worker/MOBILE-API-wo.md (real output of the server tests, invented data): closed list, Waymark, closed detail. */
object WoWaymarkFixtures {
    const val LIST_CLOSED = """{"v":1,"now":"2026-11-14T01:03:36.692Z","state":"closed","sort":"closed","scope":914,"stores":[914],"rows":[
      {"store":914,"wo":7000010,"open":false,"statusId":14,"status":"Sale complete","lane":null,"device":"Galaxy S23 Ultra","program":"Retail","bin":null,"outcome":null,"cartValue":null,"cartDue":null,"lastCartValue":149,"statusSince":null,"createdAt":"2026-11-05T17:03:34.053Z","updatedAt":"2026-11-14T00:03:34.053Z","closedAt":"2026-11-11T01:03:34.342Z","closedReason":"Sale complete","notes":0},
      {"store":914,"wo":7000011,"open":false,"statusId":15,"status":"Closed","lane":null,"device":"Galaxy S23 Ultra","program":"Retail","bin":null,"outcome":null,"cartValue":null,"cartDue":null,"lastCartValue":null,"statusSince":null,"createdAt":"2026-11-05T17:03:34.053Z","updatedAt":"2026-11-14T00:03:34.053Z","closedAt":"2026-11-04T01:03:34.344Z","closedReason":"Closed","notes":0}
    ],"next":"eyJzIjoiY2xvc2VkIiwidCI6ImNsb3NlZCIsImUiOiIyMDI2LTExLTA0VDAxOjAzOjM0LjM0NFoiLCJzdCI6OTE0LCJ3Ijo3MDAwMDExfQ"}"""

    const val LIST_CLOSED_LAST = """{"v":1,"now":"2026-11-14T01:03:36.700Z","state":"closed","sort":"closed","scope":914,"stores":[914],"rows":[
      {"store":914,"wo":7000012,"open":false,"statusId":25,"status":"Cancelled","lane":null,"device":"Pixel 8","program":"Retail","bin":null,"outcome":"Declined","cartValue":null,"cartDue":null,"lastCartValue":null,"statusSince":null,"createdAt":"2026-11-05T17:03:34.053Z","updatedAt":"2026-11-14T00:03:34.053Z","closedAt":"2026-10-25T01:03:34.344Z","closedReason":"Cancelled","notes":0}
    ],"next":null}"""

    /** The open list with tags (named and CSS colours, a one-off), follow-ups and `followUps` (first page). */
    const val LIST_WAYMARK = """{"v":1,"now":"2026-11-14T01:03:36.589Z","state":"open","sort":"status","scope":914,"stores":[914],"rows":[
      {"store":914,"wo":7000001,"open":true,"statusId":2,"status":"Need to order","lane":"order","device":"Galaxy S23 Ultra","program":"Retail","bin":null,"outcome":null,"cartValue":null,"cartDue":null,"lastCartValue":199,"statusSince":"2026-11-09T01:03:35.373Z","createdAt":"2026-11-05T17:03:34.053Z","updatedAt":"2026-11-14T00:03:34.053Z","closedAt":null,"closedReason":null,"notes":3,
       "tags":[{"tag":"Priority","color":"#d9534f"},{"tag":"Waiting on customer","color":"orange"},{"tag":"One-off","color":null}],"followUp":{"kind":"callback","due":"2026-11-14"}},
      {"store":914,"wo":7000003,"open":true,"statusId":13,"status":"Ready for pickup","lane":"rfp","device":"Galaxy S23 Ultra","program":"Retail","bin":null,"outcome":null,"cartValue":149,"cartDue":149,"lastCartValue":149,"statusSince":"2026-11-13T01:03:34.149Z","createdAt":"2026-11-05T17:03:34.053Z","updatedAt":"2026-11-14T00:03:34.053Z","closedAt":null,"closedReason":null,"notes":1,
       "tags":[],"followUp":{"kind":"rfp","due":"2026-11-12"}}
    ],"next":null,"lanes":{"order":3,"start":2,"work":2,"wait":2,"rfp":2,"total":11},"followUps":{"count":3,"today":"2026-11-13"}}"""

    /** `followups=1`: only rows with a follow-up due or overdue. */
    const val LIST_FOLLOWUPS = """{"v":1,"now":"2026-11-14T01:03:36.701Z","state":"open","sort":"status","scope":914,"stores":[914],"rows":[
      {"store":914,"wo":7000003,"open":true,"statusId":13,"status":"Ready for pickup","lane":"rfp","device":"Galaxy S23 Ultra","program":"Retail","bin":null,"outcome":null,"cartValue":149,"cartDue":149,"lastCartValue":149,"statusSince":"2026-11-13T01:03:34.149Z","createdAt":"2026-11-05T17:03:34.053Z","updatedAt":"2026-11-14T00:03:34.053Z","closedAt":null,"closedReason":null,"notes":1,"tags":[],"followUp":{"kind":"rfp","due":"2026-11-12"}}
    ],"next":null,"lanes":{"order":3,"start":2,"work":2,"wait":2,"rfp":2,"total":11},"followUps":{"count":3,"today":"2026-11-13"}}"""

    const val DETAIL_CLOSED = """{"v":1,"now":"2026-11-14T01:03:36.716Z","wo":{"store":914,"wo":7000010,"open":false,"statusId":14,"status":"Sale complete","lane":null,"device":"Galaxy S23 Ultra","program":"Retail","bin":null,"outcome":null,"cartValue":null,"cartDue":null,"lastCartValue":149,"statusSince":null,"createdAt":"2026-11-05T17:03:34.053Z","updatedAt":"2026-11-14T00:03:34.053Z","closedAt":"2026-11-11T01:03:34.342Z","closedReason":"Sale complete","notes":0,"nextUpdate":"2026-11-14T05:03:34.272Z","slaEnd":"2026-11-15T01:03:34.272Z","rfpAt":null,"outcomeReason":null,"soldAt":"2026-11-11T13:03:34.272Z","tags":[],"followUp":null},
      "timeline":[{"statusId":9,"status":"Diagnostics","lane":"work","start":"2026-11-01T13:03:34.272Z","end":"2026-11-11T13:03:34.272Z","seconds":864000,"current":false}],"timelineSource":"periods",
      "parts":{"state":"done","rows":[
        {"line":"L1","label":"176255-0000514371","item":"176255","sku":"176255","name":"Screen assembly","quantity":1,"price":129.99,"status":"Sold","soldAt":"2026-11-11T13:03:35.879Z"},
        {"line":"L2","label":"176300-0000000009","item":"176255","sku":"176300","name":"Galaxy S23 screen","quantity":2,"price":5,"status":"Sold","soldAt":"2026-11-11T13:03:35.879Z"}]},
      "changes":[
        {"at":"2026-11-11T14:03:35.888Z","field":"status","old":"Sale complete","new":"77"},
        {"at":"2026-11-11T13:03:35.887Z","field":"status","old":"Diagnostics","new":"Sale complete"},
        {"at":"2026-11-10T07:03:35.883Z","field":"nextUpdate","old":null,"new":"2026-11-20T09:30:00.000Z"},
        {"at":"2026-11-09T21:03:35.882Z","field":"nextUpdate","old":"2026-11-13T15:00:00.000Z","new":null},
        {"at":"2026-11-01T13:03:35.881Z","field":"status","old":null,"new":"Diagnostics"}],
      "cart":{"value":null,"total":null,"paid":null,"due":null,"lines":[]}}"""

    /** An open work order's detail with Waymark fields and `parts: {state: null}`. */
    const val DETAIL_OPEN_WAYMARK = """{"v":1,"now":"2026-11-14T01:03:36.731Z","wo":{"store":914,"wo":7000003,"open":true,"statusId":13,"status":"Ready for pickup","lane":"rfp","device":"Galaxy S23 Ultra","program":"Retail","bin":null,"outcome":null,"cartValue":149,"cartDue":149,"lastCartValue":149,"statusSince":"2026-11-13T01:03:34.149Z","createdAt":"2026-11-05T17:03:34.053Z","updatedAt":"2026-11-14T00:03:34.053Z","closedAt":null,"closedReason":null,"notes":1,"nextUpdate":"2026-11-14T05:03:34.149Z","slaEnd":"2026-11-15T01:03:34.149Z","rfpAt":null,"outcomeReason":null,"soldAt":null,"tags":[{"tag":"Priority","color":"red"}],"followUp":{"kind":"rfp","due":"2026-11-12"}},
      "timeline":[{"statusId":13,"status":"Ready for pickup","lane":"rfp","start":"2026-11-13T01:03:34.149Z","end":null,"seconds":86403,"current":true}],"timelineSource":"periods",
      "parts":{"state":null,"rows":[]},"changes":[],
      "cart":{"value":149,"total":149,"paid":0,"due":149,"lines":[{"name":"Screen","sku":"1001","quantity":1,"price":149,"totalPrice":149,"partStatus":"Reserved"}]}}"""
}
