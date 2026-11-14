package dev.aethernet.linkpearl.feature.alerts

import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class NotificationTapTest {
    private fun tap() = Intent(Intent.ACTION_VIEW, Uri.parse("linkpearl://workorders/914-7000001"))

    @Test
    fun tappedNotificationMarksItsAlertsReadOnce() {
        val intent = NotificationTap.tag(tap(), listOf(41, 42))
        val marked = mutableListOf<List<Int>>()
        NotificationTap.consume(intent) { marked += it }
        NotificationTap.consume(intent) { marked += it } // a recreated activity sees the same intent: nothing more
        assertEquals(listOf(listOf(41, 42)), marked)
        assertFalse(intent.hasExtra(NotificationTap.EXTRA_ALERT_IDS))
        assertEquals("linkpearl://workorders/914-7000001", intent.data.toString())
    }

    @Test
    fun otherLinksMarkNothing() {
        var called = false
        NotificationTap.consume(tap()) { called = true }
        NotificationTap.consume(NotificationTap.tag(tap(), emptyList())) { called = true }
        NotificationTap.consume(null) { called = true }
        assertFalse(called)
    }
}
