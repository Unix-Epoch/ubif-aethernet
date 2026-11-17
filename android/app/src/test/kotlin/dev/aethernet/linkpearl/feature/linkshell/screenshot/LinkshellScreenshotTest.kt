package dev.aethernet.linkpearl.feature.linkshell.screenshot

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.linkshell.LinkshellScreen
import dev.aethernet.linkpearl.feature.linkshell.LsUi
import dev.aethernet.linkpearl.feature.pullbacks.PbSession
import dev.aethernet.linkpearl.feature.pullbacks.PbUi
import dev.aethernet.linkpearl.feature.pullbacks.PcItem
import dev.aethernet.linkpearl.feature.pullbacks.PcRun
import dev.aethernet.linkpearl.feature.pullbacks.PcState
import dev.aethernet.linkpearl.feature.pullbacks.PullbackScreen
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

enum class LsShot(val file: String) { Scan("scan"), Check("check"), Linked("linked"), Away("away"), PcScanning("pullbacks-pc"), PcOffline("pullbacks-pc-offline") }

/** Linkshell, and Pullbacks on a run joined from Aethernet, at phone size, dark and light. Fake data. Output `linkshell/<device>-<name>-<dark|light>.png`. */
@RunWith(ParameterizedRobolectricTestRunner::class)
class LinkshellScreenshotTest(private val shot: LsShot, private val device: Device, private val dark: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        @JvmStatic
        @Parameters(name = "{0} {1} dark={2}")
        fun params(): List<Array<Any>> = buildList { for (dark in listOf(true, false)) LsShot.entries.forEach { add(arrayOf(it, Device.Phone, dark)) } }

        private val parts = listOf("iPhone XR Back Camera (Non OEM)" to "110318", "iPhone XS Max Front Camera (Non OEM)" to "110295", "iPad 9 Glass, Black" to "565979")
        val run = PcRun("r1", "Pullback Serials.xlsx", "999999", List(180) { i ->
            val (d, sku) = parts[i % 3]
            PcItem(i, sku, d, "$sku-${(1000 + i).toString().padStart(10, '0')}", if (i < 109) PcState.Marked else if (i == 109) PcState.Already else PcState.Pending)
        })

        fun pcSession(): PbSession {
            var s = PbSession.fromRun(run)
            repeat(3) { s = s.scan(s.current!!.serial, now = "2026-11-17T15:00:00").let { n -> n.sent(n.history.last()) } }
            return s.pcResult(110, PcState.Marked).pcResult(111, PcState.Already)
        }
    }

    @Test fun render() {
        val feature = "linkshell"
        rule.shoot(feature, shot.file, device, dark) {
            LpNavScaffold(selected = TopLevel.Settings, onSelect = {}, showBar = false) {
                when (shot) {
                    LsShot.Scan -> LinkshellScreen(LsUi.Scan(), camera = { Box(Modifier.fillMaxSize().background(Lp.colors.surf3)) })
                    LsShot.Check -> LinkshellScreen(LsUi.Check("Chrome · Mac", 999999, "K7P 2QM"), storeName = { "Sandbox" })
                    LsShot.Linked -> LinkshellScreen(LsUi.Linked("Chrome · Mac", 999999, true, null, run), storeName = { "Sandbox" })
                    LsShot.Away -> LinkshellScreen(LsUi.Linked("Chrome · Mac", 999999, false, "2026-11-17T14:41:00-05:00", null), storeName = { "Sandbox" })
                    LsShot.PcScanning -> PullbackScreen(PbUi.Scanning(pcSession(), pc = true))
                    LsShot.PcOffline -> PullbackScreen(PbUi.Scanning(pcSession(), pc = false))
                }
            }
        }
    }
}
