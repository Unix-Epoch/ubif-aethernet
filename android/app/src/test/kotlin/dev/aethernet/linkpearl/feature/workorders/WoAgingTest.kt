package dev.aethernet.linkpearl.feature.workorders

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** Spread's old-card limits (`src/59-spread.js` COLUMNS): Waiting and Ready for pickup 7 days, every other status 3 days. */
class WoAgingTest {
    private val now = Instant.parse("2026-11-16T12:00:00Z").toEpochMilli()
    private fun since(minutes: Long) = Instant.ofEpochMilli(now - minutes * 60_000).toString()
    private fun row(statusId: Int?, lane: String?, minutes: Long?, open: Boolean = true) =
        WoRow(store = 914, wo = 7000001, open = open, statusId = statusId, lane = lane, statusSince = minutes?.let(::since))

    @Test fun statusGroupingMatchesSpread() {
        assertEquals(Lane.Order, WoAging.laneOf(2))
        listOf(8, 24).forEach { assertEquals(Lane.Start, WoAging.laneOf(it)) }
        listOf(9, 10, 11, 12).forEach { assertEquals(Lane.Work, WoAging.laneOf(it)) }
        listOf(3, 4, 7).forEach { assertEquals(Lane.Wait, WoAging.laneOf(it)) }
        assertEquals(Lane.Rfp, WoAging.laneOf(13))
        assertEquals("any other open status lands in Waiting", Lane.Wait, WoAging.laneOf(99))
        assertEquals("no status lands in Waiting", Lane.Wait, WoAging.laneOf(null))
    }

    @Test fun limitsByStatusThenLane() {
        listOf(2, 8, 24, 9, 10, 11, 12).forEach { assertEquals(3, WoAging.limitDays(it, null)) }
        listOf(3, 4, 7, 13, 99).forEach { assertEquals(7, WoAging.limitDays(it, null)) }
        assertEquals("the status id wins over the lane", 3, WoAging.limitDays(2, "rfp"))
        assertEquals(7, WoAging.limitDays(null, "rfp"))
        assertEquals(7, WoAging.limitDays(null, "wait"))
        assertEquals(3, WoAging.limitDays(null, "work"))
        assertEquals("nothing known = Waiting", 7, WoAging.limitDays(null, null))
    }

    @Test fun oldFromTheLimitOn() {
        val three = 3 * 1440L
        val seven = 7 * 1440L
        assertFalse(WoAging.isOld(row(10, "work", three - 1), now))
        assertTrue(WoAging.isOld(row(10, "work", three), now))
        assertFalse("Waiting at 6 days is not old", WoAging.isOld(row(4, "wait", seven - 60), now))
        assertTrue(WoAging.isOld(row(4, "wait", seven), now))
        assertFalse("Ready for pickup at 6 days is not old", WoAging.isOld(row(13, "rfp", 6 * 1440L), now))
        assertTrue(WoAging.isOld(row(13, "rfp", 9 * 1440L + 180), now))
    }

    @Test fun neverOldWithoutATimeOrWhenClosed() {
        assertFalse(WoAging.isOld(row(10, "work", null), now))
        assertFalse(WoAging.isOld(row(10, "work", 30 * 1440L, open = false), now))
        assertFalse(WoAging.isOld(row(10, "work", 0).copy(statusSince = "not a time"), now))
    }

    @Test fun labelIsWordAndTime() {
        assertEquals("Old · 9d 3h", WoAging.label(row(13, "rfp", 9 * 1440L + 180), now))
    }
}
