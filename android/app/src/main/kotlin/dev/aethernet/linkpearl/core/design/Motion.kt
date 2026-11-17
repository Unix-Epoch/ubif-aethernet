package dev.aethernet.linkpearl.core.design

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

// ---------------------------------------------------------------------------------------------------------------------------
// Motion (Nov 2026 refresh). One feel everywhere: a slightly bouncy spring for things that move into place, short fades for things
// that appear. Everything checks [LocalMotion]; with the system animations off (Settings > Accessibility > Remove animations, or the
// animator duration scale at 0) nothing moves and every value is drawn at its end state.
// ---------------------------------------------------------------------------------------------------------------------------

object LpMotion {
    /** Things that land (cards rising in, bars growing, the nav pill sliding): settles with a small overshoot. */
    fun <T> settle(): AnimationSpec<T> = spring(dampingRatio = 0.72f, stiffness = Spring.StiffnessMediumLow)
    /** Digits rolling: a touch slower and softer so the roll reads. */
    fun <T> roll(): AnimationSpec<T> = spring(dampingRatio = 0.78f, stiffness = 120f)
    /** Taps (press scale). */
    fun <T> press(): AnimationSpec<T> = spring(dampingRatio = 0.6f, stiffness = Spring.StiffnessMedium)
    /** Delay between siblings in a staggered entrance. */
    const val STAGGER_MS = 55L
}

/** False when the system animations are off; tests may provide it. */
val LocalMotion = staticCompositionLocalOf<Boolean?> { null }

/** Whether to animate: [LocalMotion] if provided, else the system setting. */
@Composable
fun motionOn(): Boolean = LocalMotion.current ?: animationsEnabled()

// ---- haptics -------------------------------------------------------------------------------------------------------------

/** Light haptics for the moments that matter: a tab change, a filter, crossing the refresh threshold, a refresh landing. */
class LpHaptics internal constructor(private val perform: (HapticFeedbackType) -> Unit) {
    /** A tab, segment or filter changed. */
    fun tick() = perform(HapticFeedbackType.SegmentTick)
    /** A pull crossed the refresh threshold. */
    fun threshold() = perform(HapticFeedbackType.GestureThresholdActivate)
    /** A refresh landed, a save went through. */
    fun confirm() = perform(HapticFeedbackType.Confirm)
    /** A scan or entry was refused (a mismatch). */
    fun reject() = perform(HapticFeedbackType.Reject)
    /** A switch turned on / off. */
    fun toggle(on: Boolean) = perform(if (on) HapticFeedbackType.ToggleOn else HapticFeedbackType.ToggleOff)
}

@Composable
fun rememberHaptics(): LpHaptics {
    val h = LocalHapticFeedback.current
    return remember(h) { LpHaptics { runCatching { h.performHapticFeedback(it) } } }
}

// ---- entrance and press --------------------------------------------------------------------------------------------------

/**
 * Rises into place the first time it is composed: fades in and slides up 18dp, [index] steps of [LpMotion.STAGGER_MS] after its
 * siblings. Use on the cards of a screen (index = order on screen). Drawn at rest when motion is off.
 */
@Composable
fun Modifier.enter(index: Int = 0): Modifier {
    if (!motionOn()) return this
    val p = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        delay(40L + index.coerceAtMost(10) * LpMotion.STAGGER_MS)
        p.animateTo(1f, spring(dampingRatio = 0.75f, stiffness = Spring.StiffnessLow))
    }
    val rise = with(LocalDensity.current) { 18.dp.toPx() }
    return graphicsLayer {
        val v = p.value
        alpha = v.coerceIn(0f, 1f)
        translationY = (1f - v) * rise
        val s = 0.98f + 0.02f * v
        scaleX = s; scaleY = s
    }
}

/** Shrinks a little while pressed. Pass the same [interaction] to the `clickable`. */
@Composable
fun Modifier.pressScale(interaction: MutableInteractionSource, pressed: Float = 0.97f): Modifier {
    if (!motionOn()) return this
    val down by interaction.collectIsPressedAsState()
    val s by animateFloatAsState(if (down) pressed else 1f, LpMotion.press(), label = "press")
    return graphicsLayer { scaleX = s; scaleY = s }
}

// ---- rolling figures -----------------------------------------------------------------------------------------------------

/**
 * A figure whose digits roll into place like an odometer: from 0 the first time it is shown, from the old digit when the value
 * changes (a refresh). "$" leads in a smaller, softer size; a trailing "%" likewise. Any other character (",", ".", "—") is drawn
 * as is. TalkBack reads [text] once. When the figure is wider than the room it has, the size steps down (to [minSize]).
 */
@Composable
fun RollingFigure(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = LpType.Big,
    color: Color = Lp.colors.fg,
    affixColor: Color = Lp.colors.soft,
    minSize: TextUnit = 24.sp,
    animateIn: Boolean = true,
) {
    val lead = text.startsWith("$")
    val trail = text.endsWith("%")
    val body = text.removePrefix("$").removeSuffix("%")
    val measurer = rememberTextMeasurer()
    BoxWithConstraints(modifier.clearAndSetSemantics { contentDescription = text }) {
        // Fit: measure the whole figure at the full size and scale down if it does not fit.
        val full = measurer.measure(text, style, maxLines = 1).size.width
        val room = constraints.maxWidth
        val scale = if (constraints.hasBoundedWidth && full > room && full > 0) room.toFloat() / full else 1f
        val size = (style.fontSize.value * scale).coerceAtLeast(minSize.value).sp
        val st = style.copy(fontSize = size, lineHeight = size * 1.12f, lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.Both))
        val affix = st.copy(fontSize = size * 0.5f, lineHeight = size * 0.5f * 1.12f, letterSpacing = 0.sp)
        val rowH = with(LocalDensity.current) { (size * 1.12f).toDp() }
        Row(verticalAlignment = Alignment.Top) {
            if (lead) Text("$", style = affix, color = affixColor, modifier = Modifier.padding(top = rowH * 0.1f, end = 2.dp))
            var digitIndex = 0
            body.forEach { ch ->
                if (ch.isDigit()) {
                    RollingDigit(ch - '0', st, color, rowH, digitIndex++, animateIn)
                } else Text(ch.toString(), style = st, color = color, modifier = Modifier.height(rowH))
            }
            if (trail) Text("%", style = affix, color = affixColor, modifier = Modifier.padding(top = rowH * 0.1f, start = 2.dp))
        }
    }
}

@Composable
private fun RollingDigit(digit: Int, style: TextStyle, color: Color, rowH: Dp, index: Int, animateIn: Boolean) {
    val motion = motionOn()
    val anim = remember { Animatable(if (motion && animateIn) 0f else digit.toFloat()) }
    LaunchedEffect(digit, motion) {
        if (!motion) { anim.snapTo(digit.toFloat()); return@LaunchedEffect }
        delay(index.coerceAtMost(8) * 70L)
        anim.animateTo(digit.toFloat(), LpMotion.roll())
    }
    val measurer = rememberTextMeasurer()
    val w = with(LocalDensity.current) { measurer.measure("0", style).size.width.toDp() }
    Box(Modifier.width(w).height(rowH).clipToBounds()) {
        val px = with(LocalDensity.current) { rowH.toPx() }
        // One column 0..9 (plus a 0 below the 9 so a roll past 9 never shows a gap), moved up by the animated digit.
        Text(
            "0\n1\n2\n3\n4\n5\n6\n7\n8\n9\n0", style = style.copy(lineHeight = with(LocalDensity.current) { rowH.toSp() }),
            color = color, softWrap = false,
            modifier = Modifier.wrapContentHeight(Alignment.Top, unbounded = true).graphicsLayer { translationY = -anim.value * px },
        )
    }
}

/** Plain digits with a $ / % affix, the same look as [RollingFigure] without the motion (lists, wide tables). */
@Composable
fun StaticFigure(text: String, modifier: Modifier = Modifier, style: TextStyle = LpType.Value, color: Color = Lp.colors.fg) =
    RollingFigure(text, modifier, style, color, animateIn = false)
