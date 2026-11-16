package dev.aethernet.linkpearl.feature.workorders.screenshot

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.workorders.FollowUpSheet
import dev.aethernet.linkpearl.feature.workorders.LocalWoInlineSheets
import dev.aethernet.linkpearl.feature.workorders.TagsSheet
import dev.aethernet.linkpearl.feature.workorders.WoDetailActions
import dev.aethernet.linkpearl.feature.workorders.WoDetailUi
import dev.aethernet.linkpearl.feature.workorders.WoListActions
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

enum class WoEditShot(val file: String) { Detail("waymark-detail"), Tags("tags-sheet"), FollowUp("follow-up-sheet"), Old("old-list") }

/**
 * Waymark from the phone (the detail's edit chips, the Tags and Follow-up sheets) and the Old filter, on the phone and the inner screen,
 * dark and light. Sheets are drawn in place ([LocalWoInlineSheets]). Output: android/screenshots/workorders/.
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
class WoEditScreenshotTest(private val shot: WoEditShot, private val device: Device, private val dark: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        @JvmStatic
        @Parameters(name = "{0} {1} dark={2}")
        fun params(): List<Array<Any>> = buildList {
            for (dark in listOf(true, false)) for (d in listOf(Device.Phone, Device.Inner)) WoEditShot.entries.forEach { add(arrayOf(it, d, dark)) }
        }
    }

    private val wide get() = device == Device.Inner

    private fun detail(): WoDetailUi = when (shot) {
        WoEditShot.Tags -> WoEditSamples.tagsSheet()
        WoEditShot.FollowUp -> WoEditSamples.followSheet()
        else -> WoEditSamples.detail()
    }

    @Composable
    private fun Content() {
        when {
            shot == WoEditShot.Old -> LpNavScaffold(selected = TopLevel.WorkOrders, onSelect = {}, badges = mapOf(TopLevel.Alerts to 3)) {
                if (wide) WorkOrdersLayout(WoEditSamples.oldList(), WoEditSamples.detail(), 28.minutes, initialSelection = null, WoListActions(), WoDetailActions(), onSelect = {})
                else WorkOrdersScreen(state = WoEditSamples.oldList(), remaining = 28.minutes)
            }
            wide -> {
                // The modal sheet is its own window over the whole screen (nav included): drawn here over everything, as there.
                LpNavScaffold(selected = TopLevel.WorkOrders, onSelect = {}, badges = mapOf(TopLevel.Alerts to 3)) {
                    WorkOrdersLayout(WoEditSamples.openList(), WoEditSamples.detail(), null, initialSelection = "999999-700000016", WoListActions(), WoDetailActions(), onSelect = {})
                }
                TagsSheet(detail(), WoDetailActions())
                FollowUpSheet(detail(), WoEditSamples.today, WoDetailActions())
            }
            else -> LpNavScaffold(selected = TopLevel.WorkOrders, onSelect = {}, showBar = false) {
                WorkOrderDetailScreen(detail(), null, showBack = true, actions = WoDetailActions())
            }
        }
    }

    @Test fun render() = rule.shootWo(shot.file, device, dark) {
        CompositionLocalProvider(LocalWoInlineSheets provides true) { Box { Content() } }
    }
}
