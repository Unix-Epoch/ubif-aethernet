package dev.aethernet.linkpearl.feature.alerts

import android.content.Context
import android.content.Intent
import android.net.Uri
import org.robolectric.RuntimeEnvironment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class NotificationTapTest {
    private fun tap() = Intent(Intent.ACTION_VIEW, Uri.parse("linkpearl://workorders/914-7000001"))
    private val token = "this-installs-token"

    @Test
    fun tappedNotificationMarksItsAlertsReadOnce() {
        val intent = NotificationTap.tag(tap(), listOf(41, 42), token)
        val marked = mutableListOf<List<Int>>()
        NotificationTap.consume(intent, { token }) { marked += it }
        NotificationTap.consume(intent, { token }) { marked += it } // a recreated activity sees the same intent: nothing more
        assertEquals(listOf(listOf(41, 42)), marked)
        assertFalse(intent.hasExtra(NotificationTap.EXTRA_ALERT_IDS))
        assertFalse(intent.hasExtra(NotificationTap.EXTRA_TOKEN))
        assertEquals("linkpearl://workorders/914-7000001", intent.data.toString())
    }

    @Test
    fun otherLinksMarkNothing() {
        var called = false
        NotificationTap.consume(tap(), { token }) { called = true }
        NotificationTap.consume(NotificationTap.tag(tap(), emptyList(), token), { token }) { called = true }
        NotificationTap.consume(null, { token }) { called = true }
        assertFalse(called)
    }

    @Test
    fun idsFromAnotherAppMarkNothingAndTheLinkStillOpens() {
        var called = false
        // ids with no token, and ids with a guessed one: what any app can send to the exported activity
        val bare = tap().putExtra(NotificationTap.EXTRA_ALERT_IDS, intArrayOf(41))
        val guessed = tap().putExtra(NotificationTap.EXTRA_ALERT_IDS, intArrayOf(41)).putExtra(NotificationTap.EXTRA_TOKEN, "guess")
        NotificationTap.consume(bare, { token }) { called = true }
        NotificationTap.consume(guessed, { token }) { called = true }
        assertFalse(called)
        assertFalse(bare.hasExtra(NotificationTap.EXTRA_ALERT_IDS))
        assertFalse(guessed.hasExtra(NotificationTap.EXTRA_TOKEN))
        assertEquals("linkpearl://workorders/914-7000001", guessed.data.toString())
    }

    @Test
    fun theInstallsTokenIsMadeOnceAndKept() {
        val context = RuntimeEnvironment.getApplication() as Context
        val first = NotificationTap.token(context)
        assertEquals(43, first.length) // 32 bytes, base64url
        assertEquals(first, NotificationTap.token(context))
        assertNotEquals(first, token)
    }
}
