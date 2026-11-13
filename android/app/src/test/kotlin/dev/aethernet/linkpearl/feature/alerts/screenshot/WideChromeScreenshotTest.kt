package dev.aethernet.linkpearl.feature.alerts.screenshot

import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.data.FakeHomeData
import dev.aethernet.linkpearl.core.data.HomeScenario
import dev.aethernet.linkpearl.core.data.StoreScope
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.core.prefs.Appearance
import dev.aethernet.linkpearl.feature.home.HomeScreen
import dev.aethernet.linkpearl.feature.home.HomeUiState
import dev.aethernet.linkpearl.feature.home.HomeView
import dev.aethernet.linkpearl.feature.settings.SettingsScreen
import dev.aethernet.linkpearl.feature.settings.SettingsUiState
import dev.aethernet.linkpearl.feature.settings.StoreLine
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

/** Home and Settings on the wide inner sizes inside the bottom-bar chrome (same file names as the phone shots). */
@RunWith(ParameterizedRobolectricTestRunner::class)
class WideChromeScreenshotTest(private val device: Device, private val dark: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        @JvmStatic @Parameters(name = "{0} dark={1}") fun params() = listOf(Device.InnerMedium, Device.Inner).flatMap { d -> listOf(true, false).map { arrayOf<Any>(d, it) } }
    }

    @Test fun home() = rule.shoot("home", "allstores", device, dark) {
        LpNavScaffold(selected = TopLevel.Home, onSelect = {}, badges = mapOf(TopLevel.Alerts to 3)) {
            HomeScreen(HomeUiState(scope = StoreScope.All, view = HomeView.Ok, data = FakeHomeData.forScenario(HomeScenario.AllStores), stores = FakeHomeData.stores), onPickStore = {}, onRefresh = {})
        }
    }

    @Test fun settings() = rule.shoot("settings", "locked", device, dark) {
        val s = SettingsUiState(
            phoneName = "Pixel Fold",
            stores = listOf(StoreLine(914, "Newport News #914", "4:12 PM"), StoreLine(326, "Lynnhaven #326", "1:40 PM")),
            unlocked = false, notificationsOn = true, appearance = if (dark) Appearance.Dark else Appearance.Light,
        )
        LpNavScaffold(selected = TopLevel.Settings, onSelect = {}, badges = mapOf(TopLevel.Alerts to 3)) { SettingsScreen(s, "1.0.0 (1)") }
    }
}
