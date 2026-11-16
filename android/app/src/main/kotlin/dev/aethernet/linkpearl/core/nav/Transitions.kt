package dev.aethernet.linkpearl.core.nav

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.IntOffset
import androidx.navigation.NavBackStackEntry
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.motionOn

// ---------------------------------------------------------------------------------------------------------------------------
// Screen motion (Nov 2026 refresh): tabs slide toward the tab you picked, detail screens push in from the right, and a work order
// card grows into its detail (shared bounds) where the list and the detail share a pane scaffold.
// ---------------------------------------------------------------------------------------------------------------------------

private val slide = spring<IntOffset>(dampingRatio = 0.86f, stiffness = Spring.StiffnessMediumLow)
private fun fadeInFast() = fadeIn(tween(260, delayMillis = 40))
private fun fadeOutFast() = fadeOut(tween(160))

private fun order(entry: NavBackStackEntry): Pair<Int, Boolean> {
    val route = entry.destination.route
    val top = TopLevel.of(route)
    val isTop = TopLevel.entries.any { it.route == route }
    return (top?.ordinal ?: 0) to !isTop
}

/** NavHost enter: toward the picked tab, or in from the right for a detail. */
fun AnimatedContentTransitionScope<NavBackStackEntry>.lpEnter(): EnterTransition {
    val (from, _) = order(initialState); val (to, toDetail) = order(targetState)
    val dir = if (toDetail) 1 else if (to >= from) 1 else -1
    return slideInHorizontally(slide) { it / 6 * dir } + fadeInFast()
}

fun AnimatedContentTransitionScope<NavBackStackEntry>.lpExit(): ExitTransition {
    val (from, _) = order(initialState); val (to, toDetail) = order(targetState)
    val dir = if (toDetail) 1 else if (to >= from) 1 else -1
    return slideOutHorizontally(slide) { -it / 10 * dir } + fadeOutFast() + scaleOut(targetScale = 0.98f)
}

fun AnimatedContentTransitionScope<NavBackStackEntry>.lpPopEnter(): EnterTransition =
    slideInHorizontally(slide) { -it / 10 } + fadeInFast() + scaleIn(initialScale = 0.98f)

fun AnimatedContentTransitionScope<NavBackStackEntry>.lpPopExit(): ExitTransition =
    slideOutHorizontally(slide) { it / 6 } + fadeOutFast()

// ---- shared elements -------------------------------------------------------------------------------------------------------

@OptIn(ExperimentalSharedTransitionApi::class)
val LocalSharedScope = staticCompositionLocalOf<SharedTransitionScope?> { null }
val LocalPaneScope = staticCompositionLocalOf<AnimatedVisibilityScope?> { null }

/**
 * Marks a shared element: the same [key] on a list card and on its detail's header makes the card grow into the header (and
 * shrink back on Back). A no-op outside a shared scope (screenshots, wide panes) or with motion off.
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun Modifier.sharedCard(key: Any, shape: Shape = LpShapes.Card): Modifier {
    val shared = LocalSharedScope.current ?: return this
    val pane = LocalPaneScope.current ?: return this
    if (!motionOn()) return this
    return with(shared) {
        this@sharedCard.sharedBounds(
            rememberSharedContentState(key),
            animatedVisibilityScope = pane,
            enter = fadeIn(tween(220)), exit = fadeOut(tween(180)),
            resizeMode = SharedTransitionScope.ResizeMode.RemeasureToBounds,
            clipInOverlayDuringTransition = OverlayClip(shape),
        )
    }
}
