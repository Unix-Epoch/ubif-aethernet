package dev.aethernet.linkpearl.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class HomeModelsTest {
    // A real-shaped answer (tracker-worker/src/mobile.js buildHome) with nulls, an unknown key and a numeric scope.
    private val json = """
      {"v":1,"now":"2026-11-13T21:14:00.000Z","tz":"America/New_York","today":"2026-11-13","scope":999999,"extra":"ignored",
       "stores":[{"id":999999,"name":"Sandbox Store"},{"id":326,"name":null}],
       "days":["2026-11-07","2026-11-08","2026-11-09","2026-11-10","2026-11-11","2026-11-12","2026-11-13"],
       "sales":{"today":2418,"yesterday":2096,"week":[1980,null,2240,1890,2310,2096,2418]},
       "splh":{"today":null,"hours":null,"week":[158,null,171,149,183,166,172],"target":[160,180]},
       "rfp":{"total":885,"count":3,"oldestDays":12,"ages":[{"label":"0–2 days","n":0}]},
       "lanes":{"order":2,"start":3,"work":7,"wait":5,"rfp":3,"total":20},
       "cleaning":{"cln":null,"am":null,"rate":null,"week":[null,null,null,null,null,null,null]},
       "asOf":"2026-11-13T21:12:00.000Z","stale":false,"behind":null}
    """.trimIndent()

    @Test fun decodesTheHomeShapeKeepingNullsAsNull() {
        val d = LinkpearlJson.decodeFromString(HomeData.serializer(), json)
        assertEquals(2418.0, d.sales.today!!, 0.0)
        assertNull(d.sales.week[1])
        assertNull(d.splh.today) // "today's sales per labor hour is a dash until labor hours are uploaded"
        assertNull(d.cleaning.rate)
        assertEquals(listOf(160, 180), d.splh.target)
        assertEquals("Sandbox Store #999999", d.stores[0].label)
        assertEquals("#326", d.stores[1].label)
        assertNull(d.behind)
        assertNull(d.byStore)
        assertEquals(7, d.days.size)
    }

    @Test fun decodesAllStoresExtras() {
        val d = LinkpearlJson.decodeFromString(
            HomeData.serializer(),
            """{"v":1,"stores":[],"behind":{"id":326,"name":"Lynnhaven"},"byStore":[{"id":326,"name":"Lynnhaven","asOf":null,"stale":true,"sales":null,"splh":null}]}""",
        )
        assertEquals("Lynnhaven", d.behind!!.name)
        assertNotNull(d.byStore)
        assertNull(d.byStore!![0].sales)
    }

    @Test fun emptyAccountAnswer() {
        val d = LinkpearlJson.decodeFromString(HomeData.serializer(), """{"v":1,"stores":[],"empty":true}""")
        assertEquals(true, d.empty)
    }

    @Test fun storeScopeKeys() {
        assertEquals(StoreScope.All, StoreScope.fromKey("all"))
        assertEquals(StoreScope.All, StoreScope.fromKey(null))
        assertEquals(StoreScope.One(326), StoreScope.fromKey("326"))
        assertEquals("326", StoreScope.One(326).key)
    }

    @Test fun fakeDataIsInternallyConsistent() {
        for (s in HomeScenario.entries) {
            val d = FakeHomeData.forScenario(s) ?: continue
            assertEquals(7, d.days.size); assertEquals(7, d.sales.week.size); assertEquals(7, d.splh.week.size)
            val l = d.lanes
            assertEquals(l.total, l.order + l.start + l.work + l.wait + l.rfp)
            assertEquals(d.rfp.count, d.rfp.ages.sumOf { it.n })
        }
    }
}
