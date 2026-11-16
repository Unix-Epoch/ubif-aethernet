package dev.aethernet.linkpearl.core.nav

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpMotion
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.motionOn
import dev.aethernet.linkpearl.core.design.pageWash
import dev.aethernet.linkpearl.core.design.rememberHaptics

/**
 * Room the floating nav takes at the bottom of the screen (its height, its margin and the system navigation bar). Scrolling
 * screens add it to their bottom padding so the last card can scroll clear of the nav. 0 where the nav is hidden.
 */
val LocalNavInset = staticCompositionLocalOf { 0.dp }

private val NavHeight = 64.dp
private val NavMargin = 14.dp

/**
 * The app chrome: the page wash and the floating pill nav at every width (centred, at most 520dp wide on the fold). Stateless so
 * the screenshot tests can draw it with any content.
 *
 * [showBar] hides the nav on phone-width detail screens (it slides away; wide screens always show it).
 * Content gets the status-bar and side insets and draws under the nav; it reads [LocalNavInset] for its bottom padding.
 */
@Composable
fun LpNavScaffold(
    selected: TopLevel?,
    onSelect: (TopLevel) -> Unit,
    modifier: Modifier = Modifier,
    badges: Map<TopLevel, Int> = emptyMap(),
    showBar: Boolean = true,
    content: @Composable () -> Unit,
) {
    val c = Lp.colors
    val adaptive = LocalAdaptive.current
    val visible = showBar || !adaptive.isCompact
    val sysBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val inset = if (visible) NavHeight + NavMargin * 2 + sysBottom else sysBottom
    Box(modifier.fillMaxSize().pageWash(c)) {
        CompositionLocalProvider(LocalNavInset provides inset) {
            Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))) { content() }
        }
        AnimatedVisibility(
            visible = visible,
            modifier = Modifier.align(Alignment.BottomCenter),
            enter = slideInVertically { it } + fadeIn(),
            exit = slideOutVertically { it } + fadeOut(),
        ) {
            FloatingNav(selected, onSelect, badges, Modifier.windowInsetsPadding(WindowInsets.navigationBars).padding(horizontal = 16.dp, vertical = NavMargin).widthIn(max = 520.dp).fillMaxWidth())
        }
    }
}

/** Five round targets on a glass pill; the selected one widens to show its label, and a gradient pill slides under it. */
@Composable
private fun FloatingNav(selected: TopLevel?, onSelect: (TopLevel) -> Unit, badges: Map<TopLevel, Int>, modifier: Modifier) {
    val c = Lp.colors
    val haptics = rememberHaptics()
    val motion = motionOn()
    val bounds = remember { mutableStateMapOf<TopLevel, Pair<Float, Float>>() }
    val density = LocalDensity.current
    val sel = selected?.let { bounds[it] }
    val pillX by animateDpAsState(with(density) { (sel?.first ?: 0f).toDp() }, if (motion) LpMotion.settle() else snap(), label = "pillX")
    val pillW by animateDpAsState(with(density) { (sel?.second ?: 0f).toDp() }, if (motion) LpMotion.settle() else snap(), label = "pillW")
    Box(
        modifier.height(NavHeight)
            .shadow(18.dp, LpShapes.Pill, ambientColor = c.shadow, spotColor = c.shadow)
            .clip(LpShapes.Pill).background(c.navGlass)
            .border(1.dp, Brush.verticalGradient(0f to c.edge, 0.5f to Color.Transparent), LpShapes.Pill)
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        if (sel != null) {
            Box(
                Modifier.offset(x = pillX).width(pillW).height(46.dp)
                    .shadow(8.dp, LpShapes.Pill, ambientColor = c.barHi.copy(alpha = 0.4f), spotColor = c.barHi.copy(alpha = 0.4f))
                    .clip(LpShapes.Pill).background(Brush.linearGradient(listOf(c.navPillA, c.navPillB))),
            )
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            TopLevel.entries.forEach { dest ->
                val on = dest == selected
                val count = badges[dest] ?: 0
                val interaction = remember { MutableInteractionSource() }
                val pop by animateFloatAsState(if (on) 1.08f else 1f, if (motion) LpMotion.press() else snap(), label = "pop")
                Row(
                    Modifier.height(46.dp).clip(LpShapes.Pill)
                        .onPlaced { bounds[dest] = it.positionInParent().x to it.size.width.toFloat() }
                        .clickable(interaction, null, role = Role.Tab) { if (!on) haptics.tick(); onSelect(dest) }
                        .semantics { this.selected = on; contentDescription = if (count > 0) "${dest.label}, $count unread" else dest.label }
                        .padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box {
                        LpIcon(dest.icon, null, size = 24.dp, tint = if (on) c.onNavPill else c.soft, modifier = Modifier.graphicsLayer { scaleX = pop; scaleY = pop })
                        Badge(count, Modifier.align(Alignment.TopEnd).offset(x = 8.dp, y = (-6).dp))
                    }
                    AnimatedVisibility(on, enter = expandHorizontally() + fadeIn(), exit = shrinkHorizontally() + fadeOut()) {
                        Row {
                            Spacer(Modifier.width(8.dp))
                            Text(dest.label, style = LpType.Chip.copy(fontWeight = FontWeight.SemiBold, fontSize = 14.sp), color = c.onNavPill, maxLines = 1)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Badge(count: Int, modifier: Modifier) {
    val c = Lp.colors
    val s by animateFloatAsState(if (count > 0) 1f else 0f, if (motionOn()) LpMotion.press() else snap(), label = "badge")
    if (s <= 0.01f) return
    Box(
        modifier.graphicsLayer { scaleX = s; scaleY = s }.widthIn(min = 18.dp).height(18.dp).clip(CircleShape).background(c.acc).padding(horizontal = 4.dp),
        contentAlignment = Alignment.Center,
    ) { Text(if (count > 99) "99+" else count.toString(), style = LpType.Caption.copy(fontSize = 11.sp, lineHeight = 13.sp, fontWeight = FontWeight.Bold), color = c.onAcc) }
}

