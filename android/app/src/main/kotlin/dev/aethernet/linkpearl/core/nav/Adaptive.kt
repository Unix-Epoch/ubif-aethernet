package dev.aethernet.linkpearl.core.nav

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.material3.adaptive.HingeInfo
import androidx.compose.material3.adaptive.WindowAdaptiveInfo
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.window.core.layout.WindowSizeClass
import dev.aethernet.linkpearl.core.design.LpSpacing
import kotlin.math.max

/**
 * What the layout code needs to know about the window. Derived from the Jetpack WindowManager folding feature (through
 * material3-adaptive's `WindowAdaptiveInfo`): never from device numbers.
 */
@Immutable
data class AdaptiveState(
    /** Width below 600dp: bottom bar and one column. At 600dp and up: rail and two panes. */
    val isCompact: Boolean,
    /** The vertical fold/hinge to put the pane boundary on, in window pixels; null when the device has none or it is horizontal. */
    val hinge: Rect?,
    /** Half-opened with a horizontal fold (laptop posture). Home does not use it; Work orders' detail will (content above, actions below). */
    val isTabletop: Boolean,
    /** The tabletop fold's bounds in window pixels, when [isTabletop]. */
    val tabletopFold: Rect?,
    val info: WindowAdaptiveInfo,
) {
    val isTwoPane: Boolean get() = !isCompact

    companion object
}

fun AdaptiveState.Companion.from(info: WindowAdaptiveInfo): AdaptiveState {
    val hinges: List<HingeInfo> = info.windowPosture.hingeList
    val vertical = hinges.firstOrNull { it.isVertical }
    val horizontal = hinges.firstOrNull { !it.isVertical }
    return AdaptiveState(
        isCompact = !info.windowSizeClass.isWidthAtLeastBreakpoint(WindowSizeClass.WIDTH_DP_MEDIUM_LOWER_BOUND),
        hinge = vertical?.bounds,
        isTabletop = info.windowPosture.isTabletop,
        tabletopFold = horizontal?.bounds,
        info = info,
    )
}

val LocalAdaptive = compositionLocalOf<AdaptiveState> { error("AdaptiveProvider missing") }

/**
 * Provides [AdaptiveState] to everything below. In the app it reads the real window (size class and fold from WindowManager);
 * tests pass a fake [info] (see testing/Screenshots.kt) to simulate a hinge.
 */
@Composable
fun AdaptiveProvider(info: WindowAdaptiveInfo = currentWindowAdaptiveInfo(), content: @Composable () -> Unit) {
    val state = remember(info) { AdaptiveState.from(info) }
    CompositionLocalProvider(LocalAdaptive provides state, content = content)
}

/**
 * Two panes whose boundary sits on the hinge: the first pane ends at the hinge's left edge, the second starts at its right edge,
 * with at least [minGutter] between them (the gap on a flat fold, which reports a zero-width hinge). Nothing is placed across the
 * fold. Without a hinge the panes split evenly with the gutter in the middle.
 *
 * The hinge is in window coordinates; this layout measures its own offset in the window, so it works beside a navigation rail.
 */
@Composable
fun HingeTwoPane(
    first: @Composable () -> Unit,
    second: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    minGutter: Dp = LpSpacing.PaneGutter,
) {
    val hinge = LocalAdaptive.current.hinge
    var originX by remember { mutableFloatStateOf(0f) }
    Layout(
        content = { Box { first() }; Box { second() } },
        modifier = modifier.onGloballyPositioned { originX = it.positionInWindow().x },
    ) { measurables, constraints ->
        val w = constraints.maxWidth
        val minG = minGutter.roundToPx()
        var left: Int
        var right: Int
        val usable = hinge != null && hinge.center.x - originX in (w * 0.2f)..(w * 0.8f)
        if (usable) {
            val hw = (hinge!!.right - hinge.left).toInt()
            val g = max(hw, minG)
            val cx = (hinge.center.x - originX).toInt()
            left = cx - g / 2
            right = cx + g / 2
        } else {
            left = (w - minG) / 2
            right = left + minG
        }
        left = left.coerceIn(0, w); right = right.coerceIn(left, w)
        val a = measurables[0].measure(constraints.copy(minWidth = left, maxWidth = left))
        val b = measurables[1].measure(constraints.copy(minWidth = w - right, maxWidth = w - right))
        layout(w, if (constraints.hasBoundedHeight) constraints.maxHeight else max(a.height, b.height)) {
            a.placeRelative(0, 0)
            b.placeRelative(right, 0)
        }
    }
}
