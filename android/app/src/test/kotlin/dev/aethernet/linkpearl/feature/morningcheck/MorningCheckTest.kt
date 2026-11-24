package dev.aethernet.linkpearl.feature.morningcheck

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Morning check's walk (order, Looks right, Skip, scanning ahead) and the browser's messages. Fake data. */
class MorningCheckTest {
    private fun row(wo: String, bin: String, status: Int = 8) = McRow(wo, status, bin, "", "Phone", "Screen", "Sam Doe", "Retail", "u$wo")
    private val statuses = mapOf(8 to McStatus(8, "Ready for work", listOf(9)), 9 to McStatus(9, "Diagnostics", listOf(10)), 2 to McStatus(2, "Need to order", emptyList()))
    private fun list(vararg r: McRow) = McList("run1", "914", r.toList(), statuses, bins = false)

    @Test fun byLocationNaturalOrderNoLocationLast() {
        val s = McSession.of(list(row("5", "B10"), row("4", ""), row("3", "B2"), row("2", "A1"), row("1", "B2")), McOrder.Location)
        assertEquals(listOf("2", "1", "3", "5", "4"), s.items.map { it.row.wo })
    }

    @Test fun byStatusFollowsPortalsOrderThenLocation() {
        val s = McSession.of(list(row("1", "B", 9), row("2", "A", 8), row("3", "C", 2)), McOrder.Status)
        assertEquals(listOf("2", "1", "3"), s.items.map { it.row.wo })
    }

    @Test fun looksRightAndSkipWalkTheListThenCheckSkipped() {
        var s = McSession.of(list(row("1", "A"), row("2", "B"), row("3", "C")), McOrder.Location)
        s = s.looksRight().skip().looksRight()
        assertTrue(s.complete)
        assertEquals(2, s.done); assertEquals(1, s.count(McMark.Skipped))
        s = s.checkSkipped()
        assertEquals("2", s.current?.row?.wo)
    }

    @Test fun scanningAheadBringsThatOrderForwardMarkedMovedUpAndKeepsTheRestPending() {
        var s = McSession.of(list(row("1", "A"), row("2", "B"), row("3", "C"), row("4", "D")), McOrder.Location)
        s = s.scan(" 4 ")
        assertEquals("4", s.current?.row?.wo)
        assertTrue(s.current!!.movedUp)
        assertEquals(listOf("4", "1", "2", "3"), s.items.map { it.row.wo })
        s = s.looksRight()
        assertEquals("1", s.current?.row?.wo)
        assertFalse(s.current!!.movedUp)
        assertEquals(0, s.count(McMark.Skipped))
    }

    @Test fun scanningOneAlreadyPassedReopensItWithoutLosingYourPlace() {
        var s = McSession.of(list(row("1", "A"), row("2", "B"), row("3", "C")), McOrder.Location).skip().looksRight()
        assertEquals("3", s.current?.row?.wo)
        s = s.scan("1")
        assertEquals("1", s.current?.row?.wo)
        assertEquals(McMark.Pending, s.current?.mark)
        assertFalse(s.current!!.movedUp)
        s = s.looksRight()
        assertEquals("3", s.current?.row?.wo)
    }

    @Test fun scanningAnUnknownNumberSaysSo() {
        val s = McSession.of(list(row("1", "A")), McOrder.Location).scan("999")
        assertEquals(McNote.NotOpen, s.note)
        assertEquals("1", s.current?.row?.wo)
    }

    @Test fun resultsUpdateTheOrderAndKeepWhatItWas() {
        var s = McSession.of(list(row("1", "A")), McOrder.Location)
        s = s.sending("c1", McChange(status = 9, nickname = "Blue"))
        s = s.result(McResult("run1", "c1", "1", true, emptyList(), McAfter(9, "A", "Blue", "u2")))
        val it = s.current!!
        assertEquals(McMark.Changed, it.mark); assertNull(it.sending)
        assertEquals(9, it.row.statusId); assertEquals("Blue", it.row.nickname); assertEquals(8, it.was?.statusId)
    }

    @Test fun aFailedFieldIsReportedAndTheRestKept() {
        var s = McSession.of(list(row("1", "A")), McOrder.Location).sending("c1", McChange(status = 2, note = "x"))
        s = s.result(McResult("run1", "c1", "1", false, listOf("status" to "Change this status in Portal"), McAfter(8, "A", "", "u1")))
        assertEquals(McMark.Failed, s.current?.mark)
        assertEquals("Change this status in Portal", s.current?.failed?.single()?.second)
        assertEquals(8, s.current?.was?.statusId) // the note went through
    }

    @Test fun quickBinsMostUsedFirst() {
        val s = McSession.of(list(row("1", "B2"), row("2", "B2"), row("3", "A1"), row("4", "")), McOrder.Location)
        assertEquals(listOf("B2", "A1"), McSession.bins(s.items))
    }

    @Test fun parsesTheBrowsersMessages() {
        val rows = MorningCheckLink.parseRows(Json.parseToJsonElement("""[["700001",8,"B2","Blue","iPhone 14","Screen","Riley Price","Retail","2026-11-24T08:00:00Z"],["x",8],[]]"""))
        assertEquals(1, rows.size); assertEquals("Blue", rows[0].nickname)
        val st = MorningCheckLink.parseStatuses(Json.parseToJsonElement("""[[8,"Ready for work",[9]],[13,"Ready for pickup",[]]]"""))
        assertEquals(listOf(9), st[8]?.moves); assertEquals("Ready for pickup", st[13]?.name)
        val r = MorningCheckLink.parseResult(Json.parseToJsonElement("""{"run":"r","cid":"c","wo":"1","ok":false,"row":["1",8,"B2","Blue","u"],"failed":[["bin","Not available yet"]]}""").jsonObject)!!
        assertEquals("bin" to "Not available yet", r.failed.single()); assertEquals("B2", r.after?.bin)
        assertNull(MorningCheckLink.parseResult(Json.parseToJsonElement("""{"run":"r"}""").jsonObject))
    }
}
