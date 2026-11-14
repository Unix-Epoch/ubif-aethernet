package dev.aethernet.linkpearl.feature.home.screenshot

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.data.FakeHomeData
import dev.aethernet.linkpearl.core.data.HomeScenario
import dev.aethernet.linkpearl.feature.home.RfpCard
import dev.aethernet.linkpearl.feature.home.SplhCard
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters

/** Home cards on their own at the inner screen's column width: the RFP total at every figure width, and the chart's value labels. */
@RunWith(ParameterizedRobolectricTestRunner::class)
class HomeCardsScreenshotTest(private val fontScale: Float) {
    @get:Rule val rule = createComposeRule()

    companion object {
        @JvmStatic @Parameters(name = "font{0}") fun params() = listOf(1f, 1.3f).map { arrayOf<Any>(it) }
    }

    private val base = FakeHomeData.forScenario(HomeScenario.AllStores)!!

    @Test
    fun rfpWidths() = rule.shoot("home", "cards-rfp-font$fontScale", Device.Inner, dark = true, fontScale = fontScale) {
        Column(Modifier.padding(16.dp).width(397.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            for (t in listOf(885.0, 12_480.0, 128_430.0)) RfpCard(base.copy(rfp = base.rfp.copy(total = t, count = 14, oldestDays = 12)))
        }
    }

    @Test
    fun splhChart() = rule.shoot("home", "cards-splh-font$fontScale", Device.Inner, dark = true, fontScale = fontScale) {
        Column(Modifier.padding(16.dp).width(397.dp)) { SplhCard(base, true) }
    }
}
