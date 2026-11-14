package dev.aethernet.linkpearl.feature.workorders.screenshot

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.workorders.WoDetailActions
import dev.aethernet.linkpearl.feature.workorders.WoDetailUi
import dev.aethernet.linkpearl.feature.workorders.WoListActions
import dev.aethernet.linkpearl.feature.workorders.WoListUi
import dev.aethernet.linkpearl.feature.workorders.WoParts
import dev.aethernet.linkpearl.feature.workorders.WorkOrderDetailScreen
import dev.aethernet.linkpearl.feature.workorders.WorkOrdersLayout
import dev.aethernet.linkpearl.feature.workorders.WorkOrdersScreen
import dev.aethernet.linkpearl.testing.Device
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters
import kotlin.time.Duration.Companion.minutes

enum class WoWaymarkShot(val file: String) {
    ClosedList("closed-list"), ClosedDetail("closed-detail"), ClosedDetailNoParts("closed-detail-no-parts"), FollowupsList("followups-list"), FollowupDetail("followup-detail"),
}

/**
 * Closed work orders and Auto-Waymark at phone / cover / inner sizes, dark and light. Details are full screen on the phone and the cover
 * and the slide-in panel over their list on the unfolded sizes. Output: android/screenshots/workorders/.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
class WoWaymarkScreenshotTest(private val shot: WoWaymarkShot, private val device: Device, private val dark: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        @JvmStatic
        @Parameters(name = "{0} {1} dark={2}")
        fun params(): List<Array<Any>> = buildList {
            for (dark in listOf(true, false)) {
                for (d in listOf(Device.Phone, Device.Cover, Device.Inner, Device.InnerMedium))
                    listOf(WoWaymarkShot.ClosedList, WoWaymarkShot.ClosedDetail, WoWaymarkShot.FollowupsList, WoWaymarkShot.FollowupDetail).forEach { add(arrayOf(it, d, dark)) }
                add(arrayOf(WoWaymarkShot.ClosedDetailNoParts, Device.Phone, dark))
            }
            // the closed and open details in full (they scroll past the screen)
            listOf(WoWaymarkShot.ClosedDetail, WoWaymarkShot.FollowupDetail).forEach { add(arrayOf(it, Device.PhoneXTall, true)) }
        }
    }

    private val detail get() = shot == WoWaymarkShot.ClosedDetail || shot == WoWaymarkShot.ClosedDetailNoParts || shot == WoWaymarkShot.FollowupDetail
    private val wide get() = device == Device.Inner || device == Device.InnerMedium

    private fun list(): WoListUi = when (shot) {
        WoWaymarkShot.ClosedList, WoWaymarkShot.ClosedDetail, WoWaymarkShot.ClosedDetailNoParts -> WoWaymarkSamples.closedList()
        else -> WoWaymarkSamples.followList()
    }

    private fun detailState(): WoDetailUi = when (shot) {
        WoWaymarkShot.ClosedDetail -> WoWaymarkSamples.closedDetail()
        WoWaymarkShot.ClosedDetailNoParts -> WoWaymarkSamples.closedDetail(parts = WoParts("empty"), changes = emptyList())
        else -> WoWaymarkSamples.followDetail()
    }

    @Composable
    private fun Content() {
        val d = detailState()
        when {
            detail && !wide -> LpNavScaffold(selected = TopLevel.WorkOrders, onSelect = {}, showBar = false) {
                WorkOrderDetailScreen(d, 28.minutes, showBack = true, actions = WoDetailActions())
            }
            wide -> LpNavScaffold(selected = TopLevel.WorkOrders, onSelect = {}, badges = mapOf(TopLevel.Alerts to 3)) {
                WorkOrdersLayout(list(), d, 28.minutes, initialSelection = if (detail) d.key!!.id else null, WoListActions(), WoDetailActions(), onSelect = {})
            }
            else -> LpNavScaffold(selected = TopLevel.WorkOrders, onSelect = {}, badges = mapOf(TopLevel.Alerts to 3)) {
                WorkOrdersScreen(state = list(), remaining = 28.minutes)
            }
        }
    }

    @Test fun render() = rule.shootWo(shot.file, device, dark) { Box { Content() } }
}
