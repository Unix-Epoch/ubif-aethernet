package dev.aethernet.linkpearl.feature.trends.screenshot

import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.data.FakeHomeData
import dev.aethernet.linkpearl.core.data.StoreRef
import dev.aethernet.linkpearl.core.data.StoreScope
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.trends.FakeTrends
import dev.aethernet.linkpearl.feature.trends.TrendPeriod
import dev.aethernet.linkpearl.feature.trends.TrendsScreen
import dev.aethernet.linkpearl.feature.trends.TrendsUi
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.Problem
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

enum class TrShot(val file: String) { Week("week"), MonthAll("month-allstores"), YearAll("year-allstores"), Loading("loading"), Error("error"), Offline("offline"), Empty("empty") }

/** Trends at phone / cover / inner sizes, dark and light (a detail screen: no bottom bar on the phone). Output `trends/<device>-<name>-<dark|light>.png`. */
@RunWith(ParameterizedRobolectricTestRunner::class)
class TrendsScreenshotTest(private val shot: TrShot, private val device: Device, private val dark: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        private val stores = listOf(StoreRef(999999, "Sandbox"), StoreRef(326, "Lynnhaven"))

        @JvmStatic
        @Parameters(name = "{0} {1} dark={2}")
        fun params(): List<Array<Any>> = buildList {
            for (dark in listOf(true, false)) {
                for (d in listOf(Device.Phone, Device.Inner)) listOf(TrShot.Week, TrShot.MonthAll).forEach { add(arrayOf(it, d, dark)) }
                listOf(TrShot.YearAll, TrShot.Loading, TrShot.Error, TrShot.Offline, TrShot.Empty).forEach { add(arrayOf(it, Device.Phone, dark)) }
            }
            add(arrayOf(TrShot.Week, Device.Cover, true))
            add(arrayOf(TrShot.MonthAll, Device.PhoneTall, true))
        }

        fun ui(shot: TrShot): TrendsUi {
            val base = TrendsUi(stores = stores, deviceToday = FakeHomeData.TODAY)
            return when (shot) {
                TrShot.Week -> base.copy(scope = StoreScope.One(999999), view = LoadView.Ok, data = FakeTrends.week())
                TrShot.MonthAll -> base.copy(period = TrendPeriod.Month, view = LoadView.Ok, data = FakeTrends.month())
                TrShot.YearAll -> base.copy(period = TrendPeriod.Year, view = LoadView.Ok, data = FakeTrends.year())
                TrShot.Loading -> base.copy(scope = StoreScope.One(999999), view = LoadView.Loading)
                TrShot.Error -> base.copy(scope = StoreScope.One(999999), view = LoadView.Error, problem = Problem.Server)
                TrShot.Offline -> base.copy(scope = StoreScope.One(999999), view = LoadView.Ok, data = FakeTrends.week(), problem = Problem.Offline)
                TrShot.Empty -> base.copy(view = LoadView.Ok, data = dev.aethernet.linkpearl.feature.trends.TrendsData(empty = true, stores = emptyList()))
            }
        }
    }

    @Test fun render() = rule.shoot("trends", shot.file, device, dark) {
        LpNavScaffold(selected = TopLevel.Home, onSelect = {}, showBar = false, badges = mapOf(TopLevel.Alerts to 3)) { TrendsScreen(ui(shot)) }
    }
}
