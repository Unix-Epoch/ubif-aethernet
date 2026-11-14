package dev.aethernet.linkpearl.core.nav.screenshot

import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.alerts.AlertsScreen
import dev.aethernet.linkpearl.feature.settings.SettingsScreen
import dev.aethernet.linkpearl.feature.workorders.WorkOrdersScreen
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

/**
 * The navigation chrome (bottom bar on phones, rail on the Fold's inner screen) around the real screens (empty state). 
 * replace the stub screens; this test keeps drawing whatever the screen composable is.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
class NavChromeScreenshotTest(private val device: Device, private val dest: TopLevel, private val dark: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        @JvmStatic
        @Parameters(name = "{0} {1} dark={2}")
        fun params(): List<Array<Any>> = buildList {
            for (d in listOf(Device.Phone, Device.Cover, Device.Inner))
                for (t in listOf(TopLevel.Alerts, TopLevel.WorkOrders, TopLevel.Retrace, TopLevel.Settings))
                    for (dark in listOf(true, false)) add(arrayOf(d, t, dark))
        }
    }

    @Test
    fun render() = rule.shoot("nav", dest.route, device, dark) {
        LpNavScaffold(selected = dest, onSelect = {}, badges = mapOf(TopLevel.Alerts to 3)) {
            when (dest) {
                TopLevel.Alerts -> AlertsScreen()
                TopLevel.WorkOrders -> WorkOrdersScreen()
                TopLevel.Retrace -> dev.aethernet.linkpearl.feature.retrace.RetraceScreen(dev.aethernet.linkpearl.feature.retrace.RetraceUi())
                TopLevel.Settings -> SettingsScreen()
                TopLevel.Home -> Unit
            }
        }
    }
}
