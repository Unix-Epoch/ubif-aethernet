package dev.aethernet.linkpearl.core.design

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshState
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

// ---------------------------------------------------------------------------------------------------------------------------
// Surfaces of the Nov 2026 refresh: the page wash, the hero card with its drifting "nacre" glows, store avatars, the pearl
// pull-to-refresh, glass controls.
// ---------------------------------------------------------------------------------------------------------------------------

/** The page background: the page colour with two faint washes (top right warm, upper left cool). */
fun Modifier.pageWash(c: LpColors): Modifier = drawBehind {
    drawRect(c.page)
    drawRect(Brush.radialGradient(listOf(c.washA, c.washA.copy(alpha = 0f)), center = Offset(size.width * 0.9f, -size.height * 0.05f), radius = size.width * 1.05f))
    drawRect(Brush.radialGradient(listOf(c.washB, c.washB.copy(alpha = 0f)), center = Offset(-size.width * 0.15f, size.height * 0.2f), radius = size.width * 0.9f))
}

/**
 * The hero card: the one card per screen that carries the figure that matters most (today's sales, the Trends total, a work
 * order's device). A diagonal gradient with three soft glows that drift slowly, and a light that sweeps across once each time
 * [shineKey] changes (pass the data's "as of" so a refresh that lands shines). Static when motion is off.
 */
@Composable
fun LpHeroCard(
    modifier: Modifier = Modifier,
    shineKey: Any? = null,
    description: String? = null,
    padding: Dp = 18.dp,
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = Lp.colors
    val motion = motionOn()
    val t = if (motion) {
        val tr = rememberInfiniteTransition(label = "nacre")
        tr.animateFloat(0f, 1f, infiniteRepeatable(tween(18_000, easing = LinearEasing), RepeatMode.Restart), label = "drift").value
    } else 0.12f
    val sheen = remember { Animatable(1.2f) }
    var seen by remember { mutableStateOf(false) }
    LaunchedEffect(shineKey, motion) {
        if (!motion) return@LaunchedEffect
        if (seen) { sheen.snapTo(-0.4f); sheen.animateTo(1.2f, tween(1100)) }
        seen = true
    }
    val interaction = remember { MutableInteractionSource() }
    val shape = LpShapes.Card
    Column(
        modifier.fillMaxWidth()
            .let { if (onClick != null) it.pressScale(interaction) else it }
            .shadow(16.dp, shape, clip = false, ambientColor = c.shadow, spotColor = c.shadow)
            .clip(shape)
            .drawBehind {
                drawRect(Brush.linearGradient(listOf(c.heroA, c.heroB, c.heroC), start = Offset.Zero, end = Offset(size.width, size.height)))
                val a = (t * 2 * PI).toFloat()
                val r = size.maxDimension
                fun glow(col: Color, cx: Float, cy: Float, rad: Float) =
                    drawCircle(Brush.radialGradient(listOf(col, col.copy(alpha = 0f)), center = Offset(cx, cy), radius = rad), rad, Offset(cx, cy))
                glow(c.glowWarm, size.width * (0.82f + 0.08f * cos(a)), size.height * (0.12f + 0.12f * sin(a)), r * 0.55f)
                glow(c.glowCool, size.width * (0.25f + 0.15f * sin(a + 1.3f)), size.height * (0.05f + 0.1f * cos(a + 0.7f)), r * 0.45f)
                glow(c.glowTeal, size.width * (0.15f + 0.1f * cos(a + 2.4f)), size.height * (1.05f + 0.08f * sin(a + 2f)), r * 0.5f)
            }
            .border(1.dp, Brush.verticalGradient(0f to c.edge.copy(alpha = (c.edge.alpha * 1.8f).coerceAtMost(1f)), 0.4f to Color.Transparent), shape)
            .drawWithContent {
                drawContent()
                val p = sheen.value
                if (p in -0.4f..1.15f) {
                    val x = size.width * p
                    val w = size.width * 0.45f
                    drawRect(Brush.linearGradient(listOf(Color.Transparent, c.sheen, Color.Transparent), start = Offset(x - w, 0f), end = Offset(x + w * 0.4f, size.height * 0.6f)))
                }
            }
            .let { if (onClick != null) it.clickable(interaction, LocalIndication.current, role = Role.Button, onClick = onClick) else it }
            .padding(padding)
            .let { if (description != null) it.semantics { contentDescription = description } else it },
        content = content,
    )
}

/** Glass fill for a control that sits straight on the page (search field, store pill, filter chips). */
@Composable
fun Modifier.glass(shape: Shape = LpShapes.Pill): Modifier {
    val c = Lp.colors
    return if (c.isDark) clip(shape).background(c.glass).border(1.dp, Brush.verticalGradient(0f to c.edge, 0.5f to Color.Transparent), shape)
    else shadow(4.dp, shape, ambientColor = c.shadow, spotColor = c.shadow).clip(shape).background(c.glass)
}

// ---- stores ----------------------------------------------------------------------------------------------------------------

/** A colour per store, stable across screens (avatar, dots on cards, rows in By store). [index] = position in the approved list. */
@Composable
fun storeColor(index: Int): Color = with(Lp.colors) { listOf(lilac, peachStore(), teal, info, good)[Math.floorMod(index, 5)] }

@Composable
private fun LpColors.peachStore(): Color = if (isDark) Color(0xFFF2A58A) else Color(0xFFC2541F)

/** A round letter badge in the store's colour ("S" for Sandbox). Decorative: the name is always next to it. */
@Composable
fun StoreAvatar(name: String, color: Color, modifier: Modifier = Modifier, size: Dp = 26.dp) {
    val letter = name.trim().firstOrNull { it.isLetterOrDigit() }?.uppercaseChar()?.toString() ?: "#"
    Box(modifier.size(size).clip(CircleShape).background(color), contentAlignment = Alignment.Center) {
        Text(letter, style = LpType.Chip.copy(fontFamily = LpDisplay, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.48f).sp), color = if (Lp.colors.isDark) Lp.colors.page else Color.White)
    }
}

// ---- pull to refresh ---------------------------------------------------------------------------------------------------------

/**
 * Pull down to refresh, with the pearl: it drops in and turns as you pull, spins while the refresh runs. A light buzz when the
 * pull crosses the threshold and when the refresh lands.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LpPullToRefresh(refreshing: Boolean, onRefresh: () -> Unit, modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    val state = rememberPullToRefreshState()
    val haptics = rememberHaptics()
    LaunchedEffect(state) {
        var armed = false
        snapshotFlow { state.distanceFraction >= 1f }.collect { over -> if (over && !armed) haptics.threshold(); armed = over }
    }
    var wasRefreshing by remember { mutableStateOf(refreshing) }
    LaunchedEffect(refreshing) { if (wasRefreshing && !refreshing) haptics.confirm(); wasRefreshing = refreshing }
    PullToRefreshBox(
        isRefreshing = refreshing, onRefresh = onRefresh, modifier = modifier, state = state,
        indicator = { PearlIndicator(state, refreshing, Modifier.align(Alignment.TopCenter)) },
        content = content,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PearlIndicator(state: PullToRefreshState, refreshing: Boolean, modifier: Modifier) {
    val spin = if (refreshing && motionOn()) {
        rememberInfiniteTransition(label = "pearl").animateFloat(0f, 360f, infiniteRepeatable(tween(900, easing = LinearEasing)), label = "spin").value
    } else 0f
    val f = if (refreshing) 1f else state.distanceFraction.coerceIn(0f, 1.4f)
    Box(
        modifier.graphicsLayer {
            translationY = (f * 72.dp.toPx()) - 44.dp.toPx()
            alpha = (f * 1.6f).coerceIn(0f, 1f)
            val s = 0.6f + 0.4f * f.coerceAtMost(1f)
            scaleX = s; scaleY = s
            rotationZ = if (refreshing) spin else f * 220f
        }.semantics { if (refreshing) contentDescription = "Refreshing" },
    ) { Pearl(Modifier.size(44.dp)) }
}

/** The pearl: cream sphere with a coral glow, a lilac/peach sheen band and a highlight. Same look as the launcher icon. */
@Composable
fun Pearl(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val s = size.minDimension
        val c = Offset(s / 2, s / 2)
        drawCircle(Brush.radialGradient(listOf(Color(0x8CCD6771), Color(0x00CD6771)), center = c, radius = s * 0.5f), radius = s * 0.5f, center = c)
        val r = s * 0.34f
        val light = Offset(c.x - s * 0.08f, c.y - s * 0.08f)
        drawCircle(Brush.radialGradient(0f to Color(0xFFFFFAF0), 0.5f to Color(0xFFF6ECD9), 0.85f to Color(0xFFCDBFD9), 1f to Color(0xFF9B8DB8), center = light, radius = s * 0.46f), r, c)
        rotate(0f, c) {
            drawCircle(Brush.sweepGradient(listOf(Color.Transparent, Color(0x55F2A58A), Color.Transparent, Color(0x55C1ADFF), Color.Transparent), center = c), r, c)
        }
        drawOval(Color(0xD9FFFFFF), topLeft = Offset(c.x - s * 0.15f, c.y - s * 0.17f), size = Size(s * 0.11f, s * 0.065f))
    }
}

/** A chip-sized glass pill used for counts and small toggles on the page. */
@Composable
fun GlassPill(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    Box(
        modifier.glass().let { if (onClick != null) it.clickable(role = Role.Button, onClick = onClick) else it }.padding(horizontal = 14.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) { content() }
}
