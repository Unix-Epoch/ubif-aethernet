package dev.aethernet.linkpearl.feature.alerts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationPlannerTest {
    private val names = mapOf(914 to "Sandbox Store", 326 to "Lynnhaven")
    private val stuck = alertOf(Contract.stuck700000014)

    @Test fun oneNotePerAlertWithTheWorkOrderToOpen() {
        val p = NotificationPlanner.plan(listOf(stuck), names)
        assertEquals(1, p.size)
        assertEquals("Sandbox Store", p[0].title)
        assertEquals(700000014L, p[0].workOrder)
        assertEquals("Work order 700000014 has been in Repair summary for 5 days", p[0].text)
    }

    @Test fun severalStuckInOneStoreCollapse() {
        val four = (1..4).map { stuck.copy(id = 100 + it, wo = 700000000L + it) }
        val p = NotificationPlanner.plan(four, names)
        assertEquals(1, p.size)
        assertEquals("4 work orders stuck in a status", p[0].text)
        assertEquals(listOf(101, 102, 103, 104), p[0].alertIds)
        assertNull(p[0].workOrder)
    }

    @Test fun collapsingIsPerStoreAndPerType() {
        val list = listOf(stuck.copy(id = 1), stuck.copy(id = 2), stuck.copy(id = 3, store = 326), alertOf(Contract.followup).copy(id = 4))
        val p = NotificationPlanner.plan(list, names)
        assertEquals(listOf("2 work orders stuck in a status", "Work order 700000014 has been in Repair summary for 5 days", "Follow-up due today on 700000003"), p.map { it.text })
    }

    @Test fun followupsCollapseToo() {
        val f = alertOf(Contract.followup)
        assertEquals("3 follow-ups due today", NotificationPlanner.plan(listOf(f.copy(id = 1), f.copy(id = 2), f.copy(id = 3)), names)[0].text)
    }

    @Test fun backNeverNotifies() {
        assertEquals(0, NotificationPlanner.plan(listOf(alertOf(Contract.back)), names).size)
    }

    @Test fun everyNotifyingTypeHasAChannel() {
        AlertType.configurableTypes.forEach { assert(it.channelId != null) }
        assertNull(AlertType.Back.channelId)
    }
}
