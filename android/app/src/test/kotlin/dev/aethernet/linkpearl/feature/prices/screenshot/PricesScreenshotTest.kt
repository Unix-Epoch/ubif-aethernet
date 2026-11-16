package dev.aethernet.linkpearl.feature.prices.screenshot

import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.data.StoreRef
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.prices.FakePrices
import dev.aethernet.linkpearl.feature.prices.PriceFmt
import dev.aethernet.linkpearl.feature.prices.PricesScreen
import dev.aethernet.linkpearl.feature.prices.PricesUi
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.Problem
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

enum class PrShot(val file: String) { Prices("prices"), Fold("fold"), Start("start"), NoSheet("no-sheet"), NoMatch("no-match"), Loading("loading"), Error("error") }

/** Prices at phone / cover / inner sizes, dark and light (a detail screen: no bottom bar on the phone). Output `prices/<device>-<name>-<dark|light>.png`. */
@RunWith(ParameterizedRobolectricTestRunner::class)
class PricesScreenshotTest(private val shot: PrShot, private val device: Device, private val dark: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        private val stores = listOf(StoreRef(999999, "Sandbox"), StoreRef(326, "Lynnhaven"))

        @JvmStatic
        @Parameters(name = "{0} {1} dark={2}")
        fun params(): List<Array<Any>> = buildList {
            for (dark in listOf(true, false)) {
                for (d in listOf(Device.Phone, Device.Inner)) listOf(PrShot.Prices, PrShot.Fold).forEach { add(arrayOf(it, d, dark)) }
                listOf(PrShot.Start, PrShot.NoSheet, PrShot.NoMatch, PrShot.Loading, PrShot.Error).forEach { add(arrayOf(it, Device.Phone, dark)) }
            }
            add(arrayOf(PrShot.Prices, Device.Cover, true))
        }

        fun ui(shot: PrShot): PricesUi {
            val devices = FakePrices.devices.devices
            val base = PricesUi(store = FakePrices.STORE, stores = stores, list = LoadView.Ok, syncedAt = FakePrices.SYNCED, devices = devices)
            fun typed(q: String) = PriceFmt.filter(devices, q).let { base.copy(query = q, shown = it, chosen = it.firstOrNull()) }
            return when (shot) {
                PrShot.Prices -> typed("15 pro").copy(prices = LoadView.Ok, matches = listOf(FakePrices.iphone15Pro))
                PrShot.Fold -> typed("fold").copy(prices = LoadView.Ok, matches = FakePrices.fold, matchIndex = 1)
                PrShot.Start -> base
                PrShot.NoSheet -> PricesUi(store = 326, stores = stores, list = LoadView.Ok)
                PrShot.NoMatch -> typed("pixel 9")
                PrShot.Loading -> PricesUi(store = FakePrices.STORE, stores = stores, list = LoadView.Loading)
                PrShot.Error -> typed("15 pro").copy(prices = LoadView.Error, problem = Problem.Offline)
            }
        }
    }

    @Test fun render() = rule.shoot("prices", shot.file, device, dark) {
        LpNavScaffold(selected = TopLevel.Home, onSelect = {}, showBar = false, badges = mapOf(TopLevel.Alerts to 3)) {
            PricesScreen(ui(shot), tz = "America/New_York", today = "2026-11-13")
        }
    }
}
