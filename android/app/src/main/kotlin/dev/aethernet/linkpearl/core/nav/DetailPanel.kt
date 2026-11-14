package dev.aethernet.linkpearl.core.nav

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.Lp

/**
 * Wide screens (600dp and up): the list at full width ([base]) and the detail as a right-anchored panel, 90% of the width, top of the
 * screen to the bottom bar, sliding in over a scrim. [panel] gets the top padding that clears the status bar. Starts settled open when
 * [initiallyOpen] (deep link, tests); animates only on later changes of [open].
 */
@Composable
fun SlideInPanelHost(open: Boolean, initiallyOpen: Boolean, onClose: () -> Unit, base: @Composable () -> Unit, panel: @Composable (topPadding: Dp) -> Unit) {
    val visible = remember { MutableTransitionState(initiallyOpen) }
    visible.targetState = open
    Box(Modifier.fillMaxSize()) {
        base()
        BackHandler(enabled = open) { onClose() }
        val c = Lp.colors
        // The content area sits below the status bar; the scrim and panel reach up under it, and the panel pads its content back down.
        val topInset = WindowInsets.safeDrawing.getTop(LocalDensity.current)
        val reachUp = Modifier.layout { m, cs ->
            val p = m.measure(cs.copy(minHeight = cs.maxHeight + topInset, maxHeight = cs.maxHeight + topInset))
            layout(p.width, cs.maxHeight) { p.place(0, -topInset) }
        }
        AnimatedVisibility(visible, enter = fadeIn(tween(250)), exit = fadeOut(tween(250))) {
            Box(reachUp.fillMaxSize().background(c.page.copy(alpha = 0.6f)).pointerInput(Unit) { detectTapGestures { onClose() } })
        }
        AnimatedVisibility(
            visible, modifier = Modifier.align(Alignment.CenterEnd).then(reachUp).fillMaxWidth(0.9f),
            enter = slideInHorizontally(tween(250)) { it }, exit = slideOutHorizontally(tween(250)) { it },
        ) {
            val shape = RoundedCornerShape(topStart = 24.dp, bottomStart = 24.dp)
            Box(
                Modifier.fillMaxSize().clip(shape).background(c.page).border(1.dp, c.line, shape)
                    .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
            ) {
                panel(with(LocalDensity.current) { topInset.toDp() })
            }
        }
    }
}
