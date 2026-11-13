package dev.aethernet.linkpearl.feature.workorders.screenshot

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.junit4.createComposeRule
import dev.aethernet.linkpearl.core.lock.UnlockAttempt
import dev.aethernet.linkpearl.core.lock.UnlockProblem
import dev.aethernet.linkpearl.core.nav.LpNavScaffold
import dev.aethernet.linkpearl.core.nav.TopLevel
import dev.aethernet.linkpearl.feature.workorders.LaneFilter
import dev.aethernet.linkpearl.feature.workorders.Lane
import dev.aethernet.linkpearl.feature.workorders.LoadView
import dev.aethernet.linkpearl.feature.workorders.Problem
import dev.aethernet.linkpearl.feature.workorders.SealedUi
import dev.aethernet.linkpearl.feature.workorders.SearchUi
import dev.aethernet.linkpearl.feature.workorders.UnlockOverlay
import dev.aethernet.linkpearl.feature.workorders.WoDetailActions
import dev.aethernet.linkpearl.feature.workorders.WoDetailUi
import dev.aethernet.linkpearl.feature.workorders.WoListActions
import dev.aethernet.linkpearl.feature.workorders.WoListUi
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
import kotlin.time.Duration.Companion.seconds

enum class WoShot { ListLocked, ListUnlocked, ListLoading, ListOffline, ListForbidden, ListEmptyLane, SearchNumber, SearchNeedsUnlock, SearchNoResults,
    SearchUnlocked, DetailLocked, DetailUnlocked, DetailNoKey, DetailLoading, UnlockFailed, UnlockKeyInvalidated }

/** Work orders at phone / cover / inner sizes (and tabletop for the detail), dark and light. Output: android/screenshots/workorders/. */
@RunWith(ParameterizedRobolectricTestRunner::class)
class WorkOrdersScreenshotTest(private val device: Device, private val shot: WoShot, private val dark: Boolean, private val tabletop: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        private val remaining = 28.minutes + 14.seconds

        @JvmStatic
        @Parameters(name = "{0} {1} dark={2} tabletop={3}")
        fun params(): List<Array<Any>> = buildList {
            for (dark in listOf(true, false)) {
                WoShot.entries.forEach { add(arrayOf(Device.Phone, it, dark, false)) }
                listOf(WoShot.ListLocked, WoShot.ListUnlocked, WoShot.SearchNoResults, WoShot.DetailUnlocked).forEach { add(arrayOf(Device.Cover, it, dark, false)) }
                listOf(WoShot.ListLocked, WoShot.ListUnlocked, WoShot.UnlockFailed, WoShot.SearchUnlocked).forEach { add(arrayOf(Device.Inner, it, dark, false)) }
                listOf(WoShot.DetailLocked, WoShot.DetailUnlocked).forEach { add(arrayOf(Device.InnerNoFold, it, dark, true)) }
            }
        }
    }

    private fun listState(): WoListUi = when (shot) {
        WoShot.ListUnlocked, WoShot.DetailUnlocked, WoShot.DetailNoKey -> WoSamples.list(true)
        WoShot.ListLoading -> WoListUi(stores = WoSamples.stores, view = LoadView.Loading)
        WoShot.ListOffline -> WoSamples.list(false).copy(problem = Problem.Offline)
        WoShot.ListForbidden -> WoListUi(stores = WoSamples.stores, store = 326, view = LoadView.Error, problem = Problem.Forbidden)
        WoShot.ListEmptyLane -> WoSamples.list(false).copy(rows = emptyList(), filter = LaneFilter.One(Lane.Order), lanes = WoSamples.lanes.copy(order = 0), hasMore = false)
        WoShot.SearchNumber -> WoSamples.list(false).copy(query = "7000000", search = SearchUi("7000000", results = WoSamples.rows.take(3)))
        WoShot.SearchNeedsUnlock -> WoSamples.list(false).copy(query = "riley", search = SearchUi("riley", needsUnlock = true))
        WoShot.SearchNoResults -> WoSamples.list(false).copy(query = "70000099", search = SearchUi("70000099"))
        WoShot.SearchUnlocked -> WoSamples.list(true).copy(query = "riley", search = SearchUi("riley", results = WoSamples.rows.take(1)))
        else -> WoSamples.list(false)
    }

    private fun detailState(): WoDetailUi = when (shot) {
        WoShot.DetailUnlocked, WoShot.ListUnlocked, WoShot.SearchUnlocked -> WoSamples.detail(SealedUi.Shown(WoSamples.unsealed), true)
        WoShot.DetailNoKey -> WoSamples.detail(SealedUi.NoKey, true)
        WoShot.DetailLoading -> WoDetailUi(key = WoSamples.detail(SealedUi.Locked, false).key)
        else -> WoSamples.detail(SealedUi.Locked, false)
    }

    private val unlocked get() = shot in setOf(WoShot.ListUnlocked, WoShot.DetailUnlocked, WoShot.DetailNoKey, WoShot.SearchUnlocked)
    private val attempt get() = when (shot) {
        WoShot.UnlockFailed -> UnlockAttempt.Failed(UnlockProblem.NoScreenLock)
        WoShot.UnlockKeyInvalidated -> UnlockAttempt.Failed(UnlockProblem.KeyInvalidated)
        else -> UnlockAttempt.Idle
    }
    private val isDetail get() = shot.name.startsWith("Detail")

    @Composable
    private fun Content() {
        val rem = if (unlocked) remaining else null
        val wide = device == Device.Inner || device == Device.InnerNoFold
        when {
            isDetail && !wide -> LpNavScaffold(selected = TopLevel.WorkOrders, onSelect = {}, showBar = false) {
                WorkOrderDetailScreen(detailState(), rem, showBack = true, actions = WoDetailActions())
            }
            isDetail && tabletop -> WorkOrderDetailScreen(detailState(), rem, showBack = true, actions = WoDetailActions())
            wide -> LpNavScaffold(selected = TopLevel.WorkOrders, onSelect = {}, badges = mapOf(TopLevel.Alerts to 3)) {
                WorkOrdersLayout(listState(), detailState(), rem, initialSelection = "999999-700000014", WoListActions(), WoDetailActions(), onSelect = {})
            }
            else -> LpNavScaffold(selected = TopLevel.WorkOrders, onSelect = {}, badges = mapOf(TopLevel.Alerts to 3)) {
                WorkOrdersScreen(state = listState(), remaining = rem)
            }
        }
        UnlockOverlay(attempt, onRetry = {}, onDismiss = {}, onRegisterAgain = {})
    }

    @Test fun render() = rule.shootWo(shot.name.replace(Regex("([a-z])([A-Z])"), "$1-$2").lowercase(), device, dark, tabletop) { Box { Content() } }
}

/** Font scale 1.3 on the busiest screens. */
@RunWith(ParameterizedRobolectricTestRunner::class)
class WorkOrdersFontScaleScreenshotTest(private val detail: Boolean) {
    @get:Rule val rule = createComposeRule()

    companion object {
        @JvmStatic @Parameters(name = "detail={0}") fun params() = listOf(arrayOf<Any>(false), arrayOf<Any>(true))
    }

    @Test fun render() = rule.shootWo(if (detail) "detail-unlocked" else "list-unlocked", Device.Phone, dark = true, fontScale = 1.3f) {
        if (detail) WorkOrderDetailScreen(WoSamples.detail(SealedUi.Shown(WoSamples.unsealed), true), 28.minutes, showBack = true, actions = WoDetailActions())
        else LpNavScaffold(selected = TopLevel.WorkOrders, onSelect = {}) { WorkOrdersScreen(state = WoSamples.list(true), remaining = 28.minutes) }
    }
}
