package dev.aethernet.linkpearl.feature.workorders

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

class SealedDecodingTest {
    private fun j(s: String) = Json.parseToJsonElement(s)
    private val card = Card.from(j("""{"name":"Sam Sample","customerId":"C-TEST-1","phones":["5555550123"],"emails":["sam.sample@example.com"],"imei":"490154203237518","serial":"F2LTESTSERIAL","claim":"CLM-TEST-1"}"""))

    @Test fun nameMatching() {
        assertTrue(CardMatch.matches(card, "sam"))
        assertTrue(CardMatch.matches(card, "SAMPLE"))
        assertTrue(CardMatch.matches(card, "sample sam"))
        assertTrue(CardMatch.matches(card, "m sa"))
        assertFalse(CardMatch.matches(card, "riley"))
        assertTrue("email", CardMatch.matches(card, "sam.sample@"))
        assertTrue("claim", CardMatch.matches(card, "clm-test-1"))
    }

    @Test fun phoneMatching() {
        assertTrue(CardMatch.matches(card, "0123"))
        assertTrue(CardMatch.matches(card, "(555) 555-0123"))
        assertTrue(CardMatch.matches(card, "+1 555 555 0123"))
        assertTrue(CardMatch.matches(card, "5555"))
        assertFalse("3 digits is too short for a phone", CardMatch.matches(card, "123"))
        assertFalse(CardMatch.matches(card, "0124"))
    }

    @Test fun imeiAndSerialMatching() {
        assertTrue(CardMatch.matches(card, "7518"))
        assertTrue(CardMatch.matches(card, "490154203237518"))
        assertFalse("IMEI matches by suffix only", CardMatch.matches(card, "4901"))
        assertTrue(CardMatch.matches(card, "serial"))
        assertTrue(CardMatch.matches(card, "f2ltestserial"))
        assertFalse(CardMatch.matches(card, ""))
    }

    @Test fun cardDecodingIsDefensive() {
        val c = Card.from(j("""{"name":null,"phones":["757-555-0142", null, 5],"emails":"nope"}"""))
        assertNull(c.name)
        assertEquals(listOf("7575550142", "5"), c.phones)
        assertTrue(c.emails.isEmpty())
        assertNull(Card.from(j("[]")).imei)
        assertEquals("Card(redacted)", c.toString())
    }

    @Test fun notesDecodeDefensively() {
        val snap = j("""{"notes":{"total":5,"notes":[
            {"noteId":"a","noteType":1,"noteText":"Tech started Diagnostics.","createdAt":"2026-11-10T15:00:00.000Z"},
            {"noteId":"b","noteType":2,"noteText":"Called the customer.","createdAt":"2026-11-11T15:00:00.000Z","UserDatum":{"givenName":"Casey","familyName":"Reyes"}},
            {"noteId":"c","noteText":"   "},
            "not an object",
            {"noteType":"2","noteText":"No time, no author","UserDatum":null},
            {"noteType":7,"noteText":"Odd type","createdAt":"garbage","UserDatum":{"familyName":"Only"}}
        ]},"customer_data":{"CustomerDatum":{"givenName":"Riley","familyName":"Price"},"CustomerDataPhones":[{"phone":"(757) 555-0142"},{}],"CustomerDataEmails":[{"email":"R@X.COM"}]},
        "workorder":{"workorder":{"CustomerDevice":{"imei":null,"serial":"ABC123"}}}}""")
        val u = Unsealed.from(null, snap, null)
        assertEquals(listOf("Called the customer.", "Tech started Diagnostics.", "No time, no author", "Odd type"), u.notes.map { it.text })
        assertEquals(listOf(NoteKind.Manual, NoteKind.Automatic, NoteKind.Manual, NoteKind.Unknown), u.notes.map { it.kind })
        assertEquals(listOf("Casey R.", null, null, "Only"), u.notes.map { it.author })
        assertEquals(5, u.notesTotal)
        assertEquals("Riley Price", u.name)
        assertEquals(listOf("7575550142"), u.phones)
        assertEquals(listOf("r@x.com"), u.emails)
        assertNull(u.imei)
        assertEquals("ABC123", u.serial)
    }

    @Test fun emptyOrBrokenSnapshotNeverCrashes() {
        for (s in listOf("{}", "[]", "null", "1", """{"notes":null,"customer_data":null}""", """{"notes":{"notes":{}}}""")) {
            val u = Unsealed.from(null, j(s), null)
            assertTrue(u.notes.isEmpty())
            assertNull(u.name)
        }
        assertFalse(Unsealed.from(card, null, null).hasSnapshot)
        assertEquals("Sam Sample", Unsealed.from(card, null, null).name)
    }

    @Test fun formatting() {
        val now = java.time.Instant.parse("2026-11-13T17:02:25.294Z").toEpochMilli()
        assertEquals("5d 0h", WoFmt.inStatus("2026-11-08T17:02:24.673Z", now))
        assertEquals("—", WoFmt.inStatus(null, now))
        assertEquals("5 days", WoFmt.inStatusLong("2026-11-08T17:02:24.673Z", now))
        assertTrue(WoFmt.isLong("2026-11-08T17:02:24.673Z", now))
        assertFalse(WoFmt.isLong("2026-11-12T17:02:23.484Z", now))
        assertEquals("1d 0h", WoFmt.seconds(86402))
        assertEquals("(757) 555-0142", WoFmt.phone("7575550142"))
        assertEquals("49•••••••••7518", WoFmt.mask("490154203237518"))
        assertEquals("28:14", WoFmt.countdown(28.minutes + 14.seconds))
        assertEquals("$289.99", WoFmt.money(289.99))
        val ny = ZoneId.of("America/New_York")
        assertEquals("Sun, Nov 8 · 3:58 PM", WoFmt.dayTime("2026-11-08T20:58:00Z", ny))
        assertEquals("Nov 10 · 2:14 PM", WoFmt.shortDayTime("2026-11-10T19:14:00Z", ny))
        assertEquals("https://portal.ubreakifix.net/repair/workorder/700000014", WoFmt.portalUrl(700000014))
        assertEquals(WoKey(914, 7000001), WoKey.parse("914-7000001"))
        assertEquals(WoKey(914, 7000001), WoKey.parse("914:7000001"))
        assertNull(WoKey.parse("7000001"))
    }
}
