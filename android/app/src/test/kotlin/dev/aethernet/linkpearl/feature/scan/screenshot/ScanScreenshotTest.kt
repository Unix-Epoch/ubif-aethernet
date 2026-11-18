package dev.aethernet.linkpearl.feature.scan.screenshot

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.home.HomeScreen
import dev.aethernet.linkpearl.core.data.HomeScenario
import dev.aethernet.linkpearl.feature.home.screenshot.HomeScreenshotTest
import dev.aethernet.linkpearl.feature.retrace.RetraceActions
import dev.aethernet.linkpearl.feature.retrace.RetraceScreen
import dev.aethernet.linkpearl.feature.retrace.screenshot.RetraceSamples
import dev.aethernet.linkpearl.feature.scan.ScanScreen
import dev.aethernet.linkpearl.feature.scan.ScanUi
import dev.aethernet.linkpearl.feature.workorders.WoListActions
import dev.aethernet.linkpearl.feature.workorders.WorkOrdersScreen
import dev.aethernet.linkpearl.feature.workorders.screenshot.WoSamples
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters
import kotlin.time.Duration.Companion.minutes

enum class ScanShot(val file: String) { Scan("scan"), NotFound("not-found"), Home("home"), WorkOrders("workorders"), Retrace("retrace") }

/** The scanner and the Scan button on Home, Work orders and Retrace, at phone size, dark and light. Output `scan/<device>-<name>-<dark|light>.png`. */
@RunWith(ParameterizedRobolectricTestRunner::class)
class ScanScreenshotTest(private val shot: ScanShot, private val device: Device, private val dark: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        @JvmStatic
        @Parameters(name = "{0} {1} dark={2}")
        fun params(): List<Array<Any>> = buildList { for (dark in listOf(true, false)) ScanShot.entries.forEach { add(arrayOf(it, Device.Phone, dark)) } }
    }

    @Test fun render() {
        rule.shoot("scan", shot.file, device, dark) {
            val camera: @androidx.compose.runtime.Composable ((String) -> Unit) -> Unit = { Box(Modifier.fillMaxSize().background(Lp.colors.surf3)) }
            when (shot) {
                ScanShot.Scan -> LpNavScaffold(selected = null, onSelect = {}, showBar = false) { ScanScreen(ScanUi(), onBack = {}, camera = camera) }
                ScanShot.NotFound -> LpNavScaffold(selected = null, onSelect = {}, showBar = false) {
                    ScanScreen(ScanUi(message = "900101-0000000409 not found"), onBack = {}, camera = camera)
                }
                ScanShot.Home -> LpNavScaffold(selected = TopLevel.Home, onSelect = {}) {
                    HomeScreen(HomeScreenshotTest.uiState(HomeScenario.AllStores), onPickStore = {}, onRefresh = {}, onOpenScan = {})
                }
                ScanShot.WorkOrders -> LpNavScaffold(selected = TopLevel.WorkOrders, onSelect = {}) {
                    WorkOrdersScreen(state = WoSamples.list(true), remaining = 28.minutes, actions = WoListActions(onScan = {}))
                }
                ScanShot.Retrace -> LpNavScaffold(selected = TopLevel.Retrace, onSelect = {}) { RetraceScreen(RetraceSamples.home(), actions = RetraceActions(onScan = {})) }
            }
        }
    }
}
