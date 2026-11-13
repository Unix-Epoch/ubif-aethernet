package dev.aethernet.linkpearl.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StoreZoneTest {
    private fun registered() = newSessionStore().also { it.update { s -> s.copy(deviceId = "a".repeat(32), token = "b".repeat(64), status = "active") } }

    @Test fun fallsBackUntilHomeHasReportedOne() {
        assertEquals("America/New_York", StoreZone(registered()).id)
    }

    @Test fun keepsTheZoneHomeReportsAndIgnoresNonsense() {
        val s = registered(); val z = StoreZone(s)
        z.remember("America/Chicago"); assertEquals("America/Chicago", z.id)
        z.remember("Mars/Olympus"); z.remember(null); z.remember(" "); assertEquals("America/Chicago", z.id)
    }

    @Test fun aForgottenPhoneKeepsNothing() {
        val s = newSessionStore(); StoreZone(s).remember("America/Chicago"); assertNull(s.current.tz)
    }
}
