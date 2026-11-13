package dev.aethernet.linkpearl.feature.home.screenshot

import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.data.FakeHomeData
import dev.aethernet.linkpearl.core.data.HomeScenario
import dev.aethernet.linkpearl.core.data.StoreScope
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.home.HomeScreen
import dev.aethernet.linkpearl.feature.home.HomeUiState
import dev.aethernet.linkpearl.feature.home.HomeView
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

/** Home in every state at phone / Fold cover / Fold inner sizes, dark and light, inside the navigation chrome. */
@RunWith(ParameterizedRobolectricTestRunner::class)
class HomeScreenshotTest(private val device: Device, private val scenario: HomeScenario, private val dark: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        @JvmStatic
        @Parameters(name = "{0} {1} dark={2}")
        fun params(): List<Array<Any>> = buildList {
            for (d in listOf(Device.Phone, Device.Cover, Device.Inner))
                for (s in HomeScenario.entries)
                    for (dark in listOf(true, false)) add(arrayOf(d, s, dark))
            add(arrayOf(Device.InnerNoFold, HomeScenario.AllStores, true))
            for (dark in listOf(true, false)) { add(arrayOf(Device.PhoneTall, HomeScenario.OneStore, dark)); add(arrayOf(Device.PhoneTall, HomeScenario.AllStores, dark)) }
        }

        fun uiState(s: HomeScenario): HomeUiState {
            val data = FakeHomeData.forScenario(s)
            val scope = if (s == HomeScenario.AllStores) StoreScope.All else StoreScope.One(if (s == HomeScenario.Stale) 326 else 999999)
            return when (s) {
                HomeScenario.Loading -> HomeUiState(scope = scope, view = HomeView.Loading, stores = FakeHomeData.stores, busy = true)
                HomeScenario.Error -> HomeUiState(scope = scope, view = HomeView.Error, stores = FakeHomeData.stores)
                else -> HomeUiState(scope = scope, view = HomeView.Ok, data = data, offline = s == HomeScenario.Offline, stores = FakeHomeData.stores)
            }
        }
    }

    @Test
    fun render() = rule.shoot("home", scenario.name.lowercase(), device, dark) {
        LpNavScaffold(selected = TopLevel.Home, onSelect = {}, badges = mapOf(TopLevel.Alerts to 3)) {
            HomeScreen(uiState(scenario), onPickStore = {}, onRefresh = {})
        }
    }
}
