package dev.aethernet.linkpearl.feature.retrace

/** Responses copied from tracker-worker/MOBILE-API-retrace.md (real output of the server tests, invented data; lists cut short). */
object RetraceFixtures {
    const val ITEMS = """{"v":1,"now":"2026-11-14T01:06:04.408Z","store":914,"q":null,"asOf":"2026-11-14T00:36:03.192Z","items":[
      {"item":"176255","name":"Galaxy S23 screen","category":"Screens","available":3,"onHand":6,"lastAt":"2026-11-14T00:06:03.186Z"},
      {"item":"180001","name":"Battery pack","category":"Batteries","available":122,"onHand":null,"lastAt":"2026-11-13T22:06:03.188Z"}],
      "next":"eyJhdCI6IjIwMjYtMTEtMTNUMjI6MDY6MDMuMTg4WiIsIml0ZW0iOiIxODAwMDEiLCJ0IjoiIn0"}"""

    const val ITEMS_LAST = """{"v":1,"now":"2026-11-14T01:06:04.410Z","store":914,"q":null,"asOf":"2026-11-14T00:36:03.192Z","items":[
      {"item":"190002","name":"Mystery case","category":null,"available":1,"onHand":null,"lastAt":"2026-11-12T01:06:03.188Z"}],"next":null}"""

    const val ITEMS_LABEL_JUMP = """{"v":1,"now":"2026-11-14T01:06:04.418Z","store":914,"q":"176255-0000514371","asOf":"2026-11-14T00:36:03.192Z","items":[],"next":null,
      "labels":[{"label":"176255-0000514371","item":"176255","name":"Galaxy S23 screen","now":"Sold","group":"out"}]}"""

    const val ITEMS_EMPTY = """{"v":1,"now":"2026-11-14T01:06:04.418Z","store":914,"q":"zzz","asOf":null,"items":[],"next":null}"""

    const val ITEM = """{"v":1,"now":"2026-11-14T01:06:04.435Z","store":914,"item":"176255","info":{"name":"Galaxy S23 screen","category":"Screens","onHand":6,"available":3,"lastSeen":"2026-11-13T23:06:03.168Z"},
      "counts":[{"now":"Available","group":"in","n":2},{"now":"Quarantined","group":"q","n":1},{"now":"Reserved","group":"wo","n":1},{"now":"Sold","group":"out","n":1},{"now":"Mystery","group":null,"n":4}],
      "labels":[
        {"label":"176255-0000514372","now":"Available","group":"in","wo":null,"po":"UBFPO000000001","lastKind":"received","lastAt":"2026-11-14T00:06:03.186Z"},
        {"label":"176255-0000514374","now":"Quarantined","group":"q","wo":null,"po":null,"lastKind":"defective","lastAt":"2026-11-13T05:06:03.187Z"},
        {"label":"176255-0000514373","now":"Reserved","group":"wo","wo":"7000002","po":null,"lastKind":"reserved","lastAt":"2026-11-12T19:06:03.187Z"}],
      "labelsTotal":5,
      "movements":[
        {"at":"2026-11-14T00:06:03.186Z","kind":"received","refType":"po","refId":"UBFPO000000001","label":"176255-0000514372"},
        {"at":"2026-11-13T16:06:04.203Z","kind":"received","refType":null,"refId":null,"label":"176255-0000777777"},
        {"at":"2026-11-13T15:06:03.190Z","kind":"used","refType":"wo","refId":"7000002","label":null}]}"""

    const val LABEL = """{"v":1,"now":"2026-11-14T01:06:04.444Z","store":914,"label":"176255-0000514371","row":{"label":"176255-0000514371","item":"176255","name":"Galaxy S23 screen","now":"Sold","group":"out","wo":"7000010","po":"UBFPO000000001","salesOrder":"FSO000011111"},
      "movements":[
        {"at":"2026-10-28T09:06:03.182Z","kind":"received","refType":"po","refId":"UBFPO000000001","label":"176255-0000514371"},
        {"at":"2026-11-05T17:06:03.183Z","kind":"reserved","refType":"sales_order","refId":"FSO000011111","label":"176255-0000514371"},
        {"at":"2026-11-09T21:06:03.184Z","kind":"sold","refType":"sales_order","refId":"FSO000011111","label":"176255-0000514371"}],
      "movementsTotal":3}"""

    /** A label with movements but no label row. */
    const val LABEL_NO_ROW = """{"v":1,"now":"2026-11-14T01:06:04.444Z","store":914,"label":"176255-0000999999","row":null,
      "movements":[{"at":"2026-11-09T21:06:03.184Z","kind":"some_new_kind","refType":"warehouse_table","refId":"X1","label":"176255-0000999999"}],"movementsTotal":1}"""

    const val POS = """{"v":1,"now":"2026-11-14T01:06:04.450Z","store":914,"pos":[
      {"po":"UBFPO000000003","status":"Backorder","counterpart":"Vendor A","date":"2026-11-13T01:06:03.460Z","labels":0,"received":0,"total":120},
      {"po":"UBFPO000000002","status":"Received","counterpart":"Vendor B","date":"2026-11-11T01:06:03.460Z","labels":3,"received":2,"total":4},
      {"po":"UBFPO000000001","status":"Draft","counterpart":"Vendor B","date":"2026-11-11T01:06:03.460Z","labels":null,"received":null,"total":null}],
      "next":"eyJhdCI6IjIwMjYtMTEtMTFUMDE6MDY6MDMuNDYwWiIsImlkIjoiVUJGUE8wMDAwMDAwMDEifQ"}"""

    const val POS_LAST = """{"v":1,"now":"2026-11-14T01:06:04.455Z","store":914,"pos":[
      {"po":"UBFPO000000000","status":"Open order","counterpart":"Vendor C","date":null,"labels":5,"received":2,"total":55.5}],"next":null}"""
}
