package dev.aethernet.linkpearl.feature.alerts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AlertTextTest {
    private val names = mapOf(914 to "Sandbox Store", 326 to "Lynnhaven")

    @Test fun stuckSentenceFromTheContractExample() {
        assertEquals("Work order 401 has been in Diagnostics for 3 days", AlertText.sentence(alertOf(Contract.feed.alerts(0)), names))
        assertEquals("Work order 700000014 has been in Repair summary for 5 days", AlertText.sentence(alertOf(Contract.stuck700000014), names))
    }

    @Test fun stuckSingularDay() {
        val a = alertOf(Contract.stuck700000014).copy(days = 1)
        assertEquals("Work order 700000014 has been in Repair summary for 1 day", AlertText.sentence(a, names))
    }

    @Test fun quietSentenceUsesStoreNameAndTheStoreClock() {
        // 17:40Z on Oct 15 is 1:40 PM in New York (EDT).
        assertEquals("No updates from Lynnhaven since 1:40 PM (store hours)", AlertText.sentence(alertOf(Contract.feed.alerts(1)), names))
    }

    @Test fun quietClockFollowsStandardTimeToo() {
        val a = alertOf(Contract.feed.alerts(1)).copy(since = "2026-11-13T18:40:00.000Z") // EST, UTC-5
        assertEquals("No updates from Lynnhaven since 1:40 PM (store hours)", AlertText.sentence(a, names))
    }

    @Test fun pickupPluralAndSingular() {
        val a = alertOf(Contract.pickup)
        assertEquals("3 devices have waited at Ready for pickup for over 7 days", AlertText.sentence(a, names))
        assertEquals("1 device has waited at Ready for pickup for over 1 day", AlertText.sentence(a.copy(count = 1, days = 1), names))
    }

    @Test fun followupSentence() {
        assertEquals("Follow-up due today on 700000003", AlertText.sentence(alertOf(Contract.followup), names))
    }

    @Test fun backSentence() {
        assertEquals("Updates from Lynnhaven are back", AlertText.sentence(alertOf(Contract.back), names))
    }

    @Test fun unnamedStoreFallsBack() {
        assertEquals("Updates from Store #326 are back", AlertText.sentence(alertOf(Contract.back), emptyMap()))
    }

    @Test fun metaLine() {
        assertEquals("Lynnhaven #326 · 3:41 PM", AlertText.meta(alertOf(Contract.feed.alerts(1)), names))
    }

    @Test fun hoursAndHourOfDay() {
        assertEquals("1 hour", AlertText.hours(1))
        assertEquals("2 hours", AlertText.hours(2))
        assertEquals("9:00 AM", AlertText.hourOfDay(9))
        assertEquals("12:00 AM", AlertText.hourOfDay(0))
        assertEquals("11:00 PM", AlertText.hourOfDay(23))
        assertEquals("10:00 PM", AlertText.clock24("22:00"))
    }

    @Test fun unknownTypeIsDropped() {
        val o = kotlinx.serialization.json.Json.parseToJsonElement("""{"id":1,"store":1,"type":"mystery","wo":null,"at":"2026-10-15T15:00:00.000Z"}""") as kotlinx.serialization.json.JsonObject
        assertNull(parseAlert(o))
    }

    @Test fun parsesFeedFields() {
        val f = parseFeed(Contract.feed)!!
        assertEquals(412, f.cursor); assertEquals(2, f.unread); assertEquals(true, f.more); assertEquals(398, f.next)
        assertEquals(false, f.alerts[0].read); assertEquals(true, f.alerts[0].notify)
        assertEquals("2026-10-15T22:40:00.000Z", f.alerts[1].cleared)
        assertEquals(700000014L, alertOf(Contract.stuck700000014).wo)
    }

    @Test fun groupsByStoreDay() {
        val now = "2026-10-15T20:05:00.000Z"
        val a = alertOf(Contract.feed.alerts(0))
        val yesterday = a.copy(id = 5, at = "2026-10-14T15:00:00.000Z")
        val older = a.copy(id = 4, at = "2026-10-12T15:00:00.000Z")
        val g = groupByDay(listOf(a, a.copy(id = 6), yesterday, older), now)
        assertEquals(listOf("Today", "Yesterday", "Mon, Oct 12"), g.map { it.heading })
        assertEquals(2, g[0].alerts.size)
    }

    @Test fun dayChangesAtStoreMidnightNotUtc() {
        // 02:30Z on Oct 16 is 10:30 PM on Oct 15 in New York: still "Today" when the store clock says Oct 15 late evening.
        assertEquals("Today", AlertText.dayHeading("2026-10-16T02:30:00.000Z", "2026-10-16T03:00:00.000Z"))
    }

    @Test fun factsCarryNoCustomerData() {
        val all = listOf(Contract.stuck700000014, Contract.pickup, Contract.followup, Contract.feed.alerts(1), Contract.back).map(::alertOf)
        all.forEach { a -> AlertText.facts(a, names).forEach { (k, v) -> org.junit.Assert.assertTrue(k.isNotBlank() && v.isNotBlank()) } }
        assertEquals("Ready for pickup", AlertText.facts(alertOf(Contract.followup), names).first { it.first == "Kind" }.second)
    }
}

private fun kotlinx.serialization.json.JsonObject.alerts(i: Int) = (this["alerts"] as kotlinx.serialization.json.JsonArray)[i] as kotlinx.serialization.json.JsonObject
