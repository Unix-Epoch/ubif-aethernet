package dev.aethernet.linkpearl.core.design

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FormatTest {
    @Test fun moneyRoundsAndGroups() {
        assertEquals("$2,418", Fmt.money(2418.0))
        assertEquals("$2,418", Fmt.money(2417.5)) // half rounds up, like the web app
        assertEquals("$0", Fmt.money(0.0))
        assertEquals("-$12", Fmt.money(-12.0))
        assertEquals("$1,297,000", Fmt.money(1297000.0))
    }

    @Test fun nullIsADashNeverZero() {
        assertEquals("—", Fmt.money(null))
        assertEquals("—", Fmt.hours(null))
        assertEquals("—", Fmt.percent(null))
        assertEquals("—", Fmt.count(null))
        assertEquals("—", Fmt.ordersOf(null, null))
        assertEquals("—", Fmt.clock(null, "America/New_York"))
        assertNull(splhState(null, listOf(160, 180)))
    }

    @Test fun hoursPercentCountsAndOrders() {
        assertEquals("14.1", Fmt.hours(14.06))
        assertEquals("7.1", Fmt.hours(7.1))
        assertEquals("78%", Fmt.percent(0.78))
        assertEquals("100%", Fmt.percent(1.0))
        assertEquals("14 of 18 orders", Fmt.ordersOf(14, 18))
        assertEquals("1,234", Fmt.count(1234))
        assertEquals("$160–$180", Fmt.targetRange(listOf(160, 180)))
        assertEquals("1 day", Fmt.days(1))
        assertEquals("3 days", Fmt.days(3))
    }

    @Test fun compactMoneyForChartLabels() {
        assertEquals("2.4k", Fmt.compactMoney(2418.0))
        assertEquals("1.9k", Fmt.compactMoney(1890.0))
        assertEquals("850", Fmt.compactMoney(850.0))
    }

    @Test fun clockInStoreTimeWithWeekdayWhenNotToday() {
        val tz = "America/New_York"
        assertEquals("4:12 PM", Fmt.clock("2026-11-13T21:12:00Z", tz, "2026-11-13"))
        assertEquals("1:40 PM", Fmt.clock("2026-11-13T18:40:00Z", tz, "2026-11-13"))
        assertEquals("12:05 AM", Fmt.clock("2026-11-13T05:05:00Z", tz, "2026-11-13"))
        assertEquals("Thu 4:12 PM", Fmt.clock("2026-11-12T21:12:00Z", tz, "2026-11-13"))
        // 11 PM Eastern is already the next UTC day: the store-local day decides, not UTC
        assertEquals("11:30 PM", Fmt.clock("2026-11-14T04:30:00Z", tz, "2026-11-13"))
        assertEquals("4:12 PM", Fmt.clock("2026-11-13T21:12:00Z", tz)) // no "today" given: never a weekday
        assertEquals("—", Fmt.clock("not a time", tz))
    }

    @Test fun agoReadsLikeTheBanner() {
        assertEquals("0m", Fmt.ago(0.0))
        assertEquals("34m", Fmt.ago(34.0))
        assertEquals("59m", Fmt.ago(59.4))
        assertEquals("1h 0m", Fmt.ago(60.0))
        assertEquals("2h 34m", Fmt.ago(154.0))
        assertEquals("1d 3h", Fmt.ago(27 * 60.0))
        assertEquals("0m", Fmt.ago(-5.0))
        assertEquals(154.0, Fmt.minutesBetween("2026-11-13T18:40:00Z", "2026-11-13T21:14:00Z")!!, 0.0001)
        assertNull(Fmt.minutesBetween(null, "2026-11-13T21:14:00Z"))
    }

    @Test fun freshnessLines() {
        assertEquals("As of 4:12 PM", Fmt.asOf("4:12 PM"))
        assertEquals("As of 1:40 PM · Lynnhaven behind", Fmt.asOf("1:40 PM", "Lynnhaven"))
        assertEquals("Updated 2h 34m ago · as of 1:40 PM", Fmt.stale("2h 34m", "1:40 PM"))
        assertEquals("Offline · as of Thu 3:02 PM", Fmt.offline("Thu 3:02 PM"))
        assertEquals("Couldn't refresh · as of 4:12 PM", Fmt.couldntRefresh("4:12 PM"))
    }

    @Test fun targetStateFromValue() {
        val band = listOf(160, 180)
        assertEquals(TargetState.Under, splhState(159.99, band))
        assertEquals(TargetState.On, splhState(160.0, band))
        assertEquals(TargetState.On, splhState(172.0, band))
        assertEquals(TargetState.On, splhState(180.0, band))
        assertEquals(TargetState.Over, splhState(180.01, band))
        assertEquals("Under target", TargetState.Under.label)
        assertEquals("On target", TargetState.On.label)
        assertEquals("Over target", TargetState.Over.label)
    }

    @Test fun dayLabelsAndStoreLabels() {
        assertEquals("F", Fmt.dayLetter("2026-11-13"))
        assertEquals("S", Fmt.dayLetter("2026-11-08")) // Sunday
        assertEquals("Fri", Fmt.dayName("2026-11-13"))
        assertEquals("Sandbox Store #999999", Fmt.storeLabel(999999, "Sandbox Store"))
        assertEquals("#326", Fmt.storeLabel(326, null))
    }
}
