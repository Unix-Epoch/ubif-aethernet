package dev.aethernet.linkpearl.feature.home.screenshot

import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.data.HomeScenario
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.home.HomeScreen
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

/** Font scale 1.3 (the largest the app promises to support without clipping). */
@RunWith(ParameterizedRobolectricTestRunner::class)
class HomeFontScaleScreenshotTest(private val device: Device) {
    @get:Rule val rule = createComposeRule()

    companion object {
        @JvmStatic @Parameters(name = "{0}") fun params() = listOf(Device.PhoneTall, Device.Inner).map { arrayOf<Any>(it) }
    }

    @Test
    fun fontScale13() = rule.shoot("home", "allstores-font1.3", device, dark = true, fontScale = 1.3f) {
        LpNavScaffold(selected = TopLevel.Home, onSelect = {}, badges = mapOf(TopLevel.Alerts to 3)) {
            HomeScreen(HomeScreenshotTest.uiState(HomeScenario.AllStores), onPickStore = {}, onRefresh = {})
        }
    }
}
