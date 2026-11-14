package dev.aethernet.linkpearl.feature.workorders

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Parsing of every new work order shape (the docs' examples) and the small rules around them. */
class WoWaymarkTest {
    private fun list(s: String) = WoJson.decodeFromString(WoListResponse.serializer(), s)
    private fun detail(s: String) = WoJson.decodeFromString(WoDetailResponse.serializer(), s)

    @Test fun closedListRows() {
        val l = list(WoWaymarkFixtures.LIST_CLOSED)
        assertEquals("closed", l.state); assertNull(l.closedDays); assertNull(l.lanes); assertNull(l.followUps)
        val r = l.rows[0]
        assertFalse(r.open); assertEquals(149.0, r.lastCartValue); assertEquals("Sale complete", r.closedReason); assertEquals("2026-11-11T01:03:34.342Z", r.closedAt)
        assertNull(l.rows[1].lastCartValue)
        assertTrue(r.tags.isEmpty()); assertNull(r.followUp)
        assertTrue(l.next!!.isNotEmpty())
    }

    @Test fun openRowsCarryTagsAndFollowUps() {
        val l = list(WoWaymarkFixtures.LIST_WAYMARK)
        assertEquals(FollowUpsInfo(3, "2026-11-13"), l.followUps)
        val r = l.rows[0]
        assertEquals(listOf(WoTag("Priority", "#d9534f"), WoTag("Waiting on customer", "orange"), WoTag("One-off", null)), r.tags)
        assertEquals(FollowUp("callback", "2026-11-14"), r.followUp)
        assertEquals(199.0, r.lastCartValue)
        assertEquals(FollowUpRule.Rfp, l.rows[1].followUp!!.rule)
    }

    @Test fun closedDetailPartsAndChanges() {
        val d = detail(WoWaymarkFixtures.DETAIL_CLOSED)
        assertEquals("done", d.parts!!.state)
        assertEquals(listOf("L1", "L2"), d.parts!!.rows.map { it.line })
        val p = d.parts!!.rows[1]
        assertEquals("176300-0000000009", p.label); assertEquals("Galaxy S23 screen", p.name); assertEquals(2.0, p.quantity); assertEquals(5.0, p.price)
        assertEquals(5, d.changes.size)
        assertEquals(listOf("status", "status", "nextUpdate", "nextUpdate", "status"), d.changes.map { it.field })
        assertEquals("77", d.changes[0].new)               // an id the tracker has no name for comes back as text
        assertNull(d.changes[2].old); assertEquals("2026-11-20T09:30:00.000Z", d.changes[2].new); assertNull(d.changes[3].new)
        assertFalse(d.wo.open); assertEquals(149.0, d.wo.lastCartValue); assertTrue(d.cart!!.lines.isEmpty())
    }

    @Test fun openDetailHasTagsFollowUpAndNoParts() {
        val d = detail(WoWaymarkFixtures.DETAIL_OPEN_WAYMARK)
        assertEquals(listOf(WoTag("Priority", "red")), d.wo.tags)
        assertEquals("2026-11-12", d.wo.followUp!!.due)
        assertNull(d.parts!!.state); assertTrue(d.parts!!.rows.isEmpty()); assertTrue(d.changes.isEmpty())
    }

    @Test fun olderTrackerShapesDecodeWithDefaults() {
        val d = detail(WoFixtures.DETAIL)
        assertNull("no parts key", d.parts); assertTrue(d.changes.isEmpty()); assertTrue(d.wo.tags.isEmpty()); assertNull(d.wo.followUp); assertNull(d.wo.lastCartValue)
        val l = list(WoFixtures.LIST_OPEN)
        assertNull(l.followUps); assertTrue(l.rows.all { it.tags.isEmpty() && it.followUp == null })
        // new fields the app does not know are ignored; a malformed follow-up is not drawn
        val odd = list("""{"rows":[{"store":1,"wo":2,"future":{"x":1},"tags":[{"tag":"A","extra":1}],"followUp":{"kind":"later","due":"soon"}}],"followUps":{"count":null,"today":null}}""")
        assertEquals(listOf(WoTag("A", null)), odd.rows[0].tags)
        assertFalse(odd.rows[0].followUp!!.valid); assertEquals(FollowUpRule.Rfp, odd.rows[0].followUp!!.rule)
        assertNull(odd.followUps!!.count)
    }

    @Test fun dueStateAgainstTheServersToday() {
        val f = FollowUp("rfp", "2026-11-12")
        assertEquals(DueState.Overdue, f.state("2026-11-13")); assertEquals(DueState.Today, f.state("2026-11-12")); assertEquals(DueState.Upcoming, f.state("2026-11-11"))
        assertEquals("Nov 12", f.day())
        assertEquals("Awaiting callback or device", FollowUp("callback", "2026-11-12").rule.longLabel)
    }

    @Test fun tagColours() {
        assertEquals(Color(0xFFD9670F), TagColors.parse("Orange"))
        assertEquals(Color(0xFFD9534F), TagColors.parse("#d9534f"))
        assertEquals(Color(0xFFFFAA00), TagColors.parse("#fa0"))
        assertEquals("unknown colour: grey", TagColors.parse("nonsense"), TagColors.parse("grey"))
    }
}
