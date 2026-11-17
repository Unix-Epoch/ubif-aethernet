package dev.aethernet.linkpearl.feature.pullbacks.screenshot

import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.pullbacks.PbItem
import dev.aethernet.linkpearl.feature.pullbacks.PbList
import dev.aethernet.linkpearl.feature.pullbacks.PbSaved
import dev.aethernet.linkpearl.feature.pullbacks.PbSession
import dev.aethernet.linkpearl.feature.pullbacks.PbUi
import dev.aethernet.linkpearl.feature.pullbacks.PullbackScreen
import dev.aethernet.linkpearl.feature.pullbacks.Pullbacks
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

enum class PbShot(val file: String) { Start("start"), Stores("stores"), Scanning("scanning"), Mismatch("mismatch"), Done("done") }

/** Pullbacks at phone size, dark and light (a detail screen: no bottom bar). Fake data. Output `pullbacks/<device>-<name>-<dark|light>.png`. */
@RunWith(ParameterizedRobolectricTestRunner::class)
class PullbacksScreenshotTest(private val shot: PbShot, private val device: Device, private val dark: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        @JvmStatic
        @Parameters(name = "{0} {1} dark={2}")
        fun params(): List<Array<Any>> = buildList { for (dark in listOf(true, false)) PbShot.entries.forEach { add(arrayOf(it, Device.Phone, dark)) } }

        private val items = List(180) { i ->
            val parts = listOf("iPhone XR Back Camera (Non OEM)" to 110318.0, "iPhone XS Max Front Camera (Non OEM)" to 110295.0, "iPad 9 Glass, Black" to 565979.0)
            val (d, sku) = parts[i % 3]
            PbItem("Sandbox Store #999999", sku, d, "${sku.toLong()}-${(1000 + i).toString().padStart(10, '0')}", 1.0, 12.5)
        }
        private val list = PbList(listOf("Store", "SKU", "Description", "Serial", "Return Units", "Return Value"), items.sortedWith(Pullbacks.scanOrder))

        fun ui(shot: PbShot): PbUi {
            var s = PbSession("Pullback Serials.xlsx", "Sandbox Store #999999", list)
            repeat(112) { s = s.scan(s.current!!.serial, now = "2026-11-16T15:00:00") }
            return when (shot) {
                PbShot.Start -> PbUi.Start(PbSaved("Pullback Serials.xlsx", "Sandbox Store #999999", 112, 180))
                PbShot.Stores -> PbUi.Stores("Pullback Serials.xlsx", listOf("Sandbox Store #999999" to 180, "Lynnhaven Store #326" to 183, "Windsor Woods Store #707" to 23), "Sandbox Store #999999", 3214.0)
                PbShot.Scanning -> PbUi.Scanning(s)
                PbShot.Mismatch -> PbUi.Scanning(s.scan("110295-0000000999"))
                PbShot.Done -> {
                    repeat(2) { s = s.scan("X").acceptAnyway(now = "2026-11-16T15:00:00") }
                    repeat(5) { s = s.skip() }
                    while (!s.complete) s = s.scan(s.current!!.serial, now = "2026-11-16T15:00:00")
                    PbUi.Done(s)
                }
            }
        }
    }

    @Test fun render() = rule.shoot("pullbacks", shot.file, device, dark) {
        LpNavScaffold(selected = TopLevel.Retrace, onSelect = {}, showBar = false) {
            PullbackScreen(ui(shot))
        }
    }
}
