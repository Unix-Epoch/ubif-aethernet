package dev.aethernet.linkpearl.feature.morningcheck.screenshot

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.morningcheck.McAfter
import dev.aethernet.linkpearl.feature.morningcheck.McChange
import dev.aethernet.linkpearl.feature.morningcheck.McList
import dev.aethernet.linkpearl.feature.morningcheck.McNotes
import dev.aethernet.linkpearl.feature.morningcheck.McOrder
import dev.aethernet.linkpearl.feature.morningcheck.McResult
import dev.aethernet.linkpearl.feature.morningcheck.McRow
import dev.aethernet.linkpearl.feature.morningcheck.McSession
import dev.aethernet.linkpearl.feature.morningcheck.McStatus
import dev.aethernet.linkpearl.feature.morningcheck.McUi
import dev.aethernet.linkpearl.feature.morningcheck.MorningCheckScreen
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import dev.aethernet.linkpearl.feature.workorders.Note
import dev.aethernet.linkpearl.feature.workorders.NoteKind
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

enum class McShot(val file: String) { Start("start"), Check("check"), MovedUp("moved-up"), Camera("camera"), Edit("edit"), Saved("saved"), Failed("failed"), Done("done"), Incomplete("incomplete") }

/** Morning check at phone size, dark and light. Fake data. Output `morningcheck/<device>-<name>-<dark|light>.png`. */
@RunWith(ParameterizedRobolectricTestRunner::class)
class MorningCheckScreenshotTest(private val shot: McShot, private val device: Device, private val dark: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        @JvmStatic
        @Parameters(name = "{0} {1} dark={2}")
        fun params(): List<Array<Any>> = buildList { for (dark in listOf(true, false)) McShot.entries.forEach { add(arrayOf(it, Device.Phone, dark)) } }

        private val statuses = listOf(
            McStatus(2, "Need to order", emptyList()), McStatus(3, "Awaiting item", emptyList()), McStatus(7, "Awaiting callback", emptyList()),
            McStatus(8, "Ready for work", listOf(9)), McStatus(9, "Diagnostics", listOf(10)), McStatus(10, "Work in progress", emptyList()),
            McStatus(13, "Ready for pickup", emptyList()),
        ).associateBy { it.id }
        private val devices = listOf("iPhone 14 Pro" to "Screen", "Galaxy S23" to "Battery", "Pixel 8" to "Charging port", "iPad 9" to "Glass")
        private val names = listOf("Riley Price", "Casey Hayes", "Morgan Brooks", "Jordan Ellis")
        private val bins = listOf("A1", "A2", "B1", "B2", "Back shelf", "Bench")
        private val st = listOf(8, 9, 2, 3, 7, 10)
        val list = McList("r1", "999999", List(34) { i ->
            val (d, issue) = devices[i % 4]
            McRow((700000180 + i).toString(), st[i % st.size], bins[i % bins.size], if (i % 3 == 0) "Blue case 11/26" else "", d, issue, names[i % 4], "Retail", "u$i")
        }, statuses, bins = true)

        fun walk(n: Int): McSession { var s = McSession.of(list, McOrder.Location); repeat(n) { s = s.looksRight() }; return s }
        fun saved(): McSession {
            val s = walk(11)
            val r = s.current!!.row
            return s.sending("c1", McChange(status = 9, bin = "Front shelf")).result(McResult("r1", "c1", r.wo, true, emptyList(), McAfter(9, "Front shelf", r.nickname, "u2")))
        }
        fun failed(): McSession {
            val s = walk(3) // still in A1, at Ready for work
            return s.sending("c2", McChange(status = 9)).result(McResult("r1", "c2", s.current!!.row.wo, false, listOf("status" to "Error while fetching service bench details."), null))
        }
        /** The current order is Ready for pickup but Incomplete, with its notes. */
        fun incomplete(): McSession {
            val s = walk(11)
            val i = s.idx!!
            val row = s.items[i].row.copy(statusId = 13, outcome = "Incomplete", device = "Galaxy S22", issue = "Charging port", program = "Asurion")
            val notes = listOf(
                Note("Port replaced, still not charging. Board issue, customer declined board repair.", "2026-11-23T21:12:00Z", NoteKind.Manual, null, "Sam T."),
                Note("Sam Tech marked the device as \"Ready for pickup.\" - Incomplete", "2026-11-23T21:13:00Z", NoteKind.Automatic, null, "Sam T."),
                Note("Sam Tech completed quality check.", "2026-11-23T21:05:00Z", NoteKind.Automatic, null, "Sam T."),
                Note("Called, left voicemail about board.", "2026-11-23T19:40:00Z", NoteKind.Manual, null, "Ana R."),
            )
            return s.copy(items = s.items.toMutableList().also { it[i] = it[i].copy(row = row) })
                .withNotes(McNotes(row.wo, 4, dev.aethernet.linkpearl.feature.workorders.Unsealed.sortNewestFirst(notes)))
        }
        fun done(): McSession {
            var s = saved().advance()
            while (!s.complete) s = if (s.idx == 20) s.skip() else s.looksRight()
            return s
        }
    }

    @Test fun render() {
        rule.shoot("morningcheck", shot.file, device, dark) {
            LpNavScaffold(selected = TopLevel.WorkOrders, onSelect = {}, showBar = false) {
                val camera: @androidx.compose.runtime.Composable ((String) -> Unit) -> Unit = { Box(Modifier.fillMaxSize().background(Lp.colors.surf3)) }
                when (shot) {
                    McShot.Start -> MorningCheckScreen(McUi.Start("Chrome · Mac", true, McOrder.Location))
                    McShot.Check -> MorningCheckScreen(McUi.Checking(walk(11), "Chrome · Mac", true), camera = camera)
                    McShot.MovedUp -> MorningCheckScreen(McUi.Checking(walk(11).scan("700000185"), "Chrome · Mac", true), camera = camera)
                    McShot.Camera -> MorningCheckScreen(McUi.Checking(walk(11).scan("123"), "Chrome · Mac", true), camera = camera, startScanning = true)
                    McShot.Edit -> MorningCheckScreen(McUi.Checking(walk(11), "Chrome · Mac", true), startEditing = true)
                    McShot.Saved -> MorningCheckScreen(McUi.Checking(saved(), "Chrome · Mac", true))
                    McShot.Failed -> MorningCheckScreen(McUi.Checking(failed(), "Chrome · Mac", true))
                    McShot.Done -> MorningCheckScreen(McUi.Checking(done(), "Chrome · Mac", true))
                    McShot.Incomplete -> MorningCheckScreen(McUi.Checking(incomplete(), "Chrome · Mac", true))
                }
            }
        }
    }
}
