package dev.aethernet.linkpearl.feature.retrace.screenshot

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.SlideInPanelHost
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.retrace.RetraceDetailActions
import dev.aethernet.linkpearl.feature.retrace.RetraceItemScreen
import dev.aethernet.linkpearl.feature.retrace.RetraceLabelScreen
import dev.aethernet.linkpearl.feature.retrace.RetraceScreen
import dev.aethernet.linkpearl.feature.retrace.RetraceView
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.LocalWoClock
import dev.aethernet.linkpearl.feature.workorders.Problem
import dev.aethernet.linkpearl.feature.workorders.WoClock
import dev.aethernet.linkpearl.feature.workorders.screenshot.WoSamples
import dev.aethernet.linkpearl.testing.Device
import dev.aethernet.linkpearl.testing.shoot
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.ParameterizedRobolectricTestRunner.Parameters
import java.time.ZoneId

enum class RtShot(val file: String) {
    Home("home"), PurchaseOrders("purchase-orders"), ItemDetail("item-detail"), LabelDetail("label-detail"),
    Loading("loading"), Offline("offline"), LabelJump("label-jump"), NoMatch("no-match"), ItemError("item-error"),
}

/** Retrace's shots: the shared harness plus a fixed clock. Output: `retrace/<device>-<name>-<dark|light>.png`. */
fun ComposeContentTestRule.shootRetrace(name: String, device: Device, dark: Boolean, content: @Composable () -> Unit) =
    shoot(
        "retrace", name, device, dark,
        providers = arrayOf(LocalWoClock provides WoClock({ WoSamples.NOW }, ZoneId.of("America/New_York"), ticks = false)), content = content,
    )

/**
 * Retrace at phone / cover / inner sizes, dark and light. A detail is full screen on the phone and the cover, and the slide-in panel over the
 * list on the unfolded sizes (the same panel as Work orders).
 */
@RunWith(ParameterizedRobolectricTestRunner::class)
class RetraceScreenshotTest(private val shot: RtShot, private val device: Device, private val dark: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        @JvmStatic
        @Parameters(name = "{0} {1} dark={2}")
        fun params(): List<Array<Any>> = buildList {
            for (dark in listOf(true, false)) {
                for (d in listOf(Device.Phone, Device.Cover, Device.Inner, Device.InnerMedium))
                    listOf(RtShot.Home, RtShot.PurchaseOrders, RtShot.ItemDetail, RtShot.LabelDetail).forEach { add(arrayOf(it, d, dark)) }
                listOf(RtShot.Loading, RtShot.Offline, RtShot.LabelJump, RtShot.NoMatch, RtShot.ItemError).forEach { add(arrayOf(it, Device.Phone, dark)) }
            }
            add(arrayOf(RtShot.ItemDetail, Device.PhoneXTall, true))
        }
    }

    private val detail get() = shot == RtShot.ItemDetail || shot == RtShot.LabelDetail || shot == RtShot.ItemError
    private val wide get() = device == Device.Inner || device == Device.InnerMedium
    private val store = 999999

    private fun home() = when (shot) {
        RtShot.PurchaseOrders -> RetraceSamples.home(RetraceView.PurchaseOrders)
        RtShot.Loading -> RetraceSamples.home(load = LoadView.Loading)
        RtShot.Offline -> RetraceSamples.home(load = LoadView.Ok, problem = Problem.Offline)
        RtShot.LabelJump -> RetraceSamples.labelJump()
        RtShot.NoMatch -> RetraceSamples.noMatch()
        else -> RetraceSamples.home()
    }

    @Composable
    private fun Detail(modifier: Modifier = Modifier, close: Boolean) {
        val a = RetraceDetailActions()
        when (shot) {
            RtShot.ItemDetail -> RetraceItemScreen(RetraceSamples.itemUi(), "900101", store, true, a, modifier, closeIcon = close)
            RtShot.ItemError -> RetraceItemScreen(RetraceSamples.itemError(Problem.Server), "900101", store, true, a, modifier, closeIcon = close)
            else -> RetraceLabelScreen(RetraceSamples.labelUi(), "900101-0000000409", store, true, a, modifier, closeIcon = close)
        }
    }

    @Composable
    private fun Content() {
        val h = home()
        when {
            detail && !wide -> LpNavScaffold(selected = TopLevel.Retrace, onSelect = {}, showBar = false) { Detail(close = false) }
            wide -> LpNavScaffold(selected = TopLevel.Retrace, onSelect = {}, badges = mapOf(TopLevel.Alerts to 3)) {
                if (detail) SlideInPanelHost(
                    open = true, initiallyOpen = true, onClose = {},
                    base = { RetraceScreen(h, twoColumns = true, selectedItem = if (shot == RtShot.ItemDetail) "900101" else null) },
                    panel = { top -> Detail(Modifier.padding(top = top), close = true) },
                ) else RetraceScreen(h, twoColumns = true)
            }
            else -> LpNavScaffold(selected = TopLevel.Retrace, onSelect = {}, badges = mapOf(TopLevel.Alerts to 3)) { RetraceScreen(h) }
        }
    }

    @Test fun render() = rule.shootRetrace(shot.file, device, dark) { Box { Content() } }
}
