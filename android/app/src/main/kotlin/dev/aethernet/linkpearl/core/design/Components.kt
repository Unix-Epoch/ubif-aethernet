package dev.aethernet.linkpearl.core.design

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog

// ---------------------------------------------------------------------------------------------------------------------------
// Shared building blocks. core/design is scaffold-owned: feature agents use these and request additions in their report.
// ---------------------------------------------------------------------------------------------------------------------------

/** Card surface: surf fill, 1dp line border, 20dp corners, 16dp padding. [description] makes the card one TalkBack stop's label. */
@Composable
fun LpCard(modifier: Modifier = Modifier, description: String? = null, padding: Dp = LpSpacing.L, content: @Composable ColumnScope.() -> Unit) {
    val c = Lp.colors
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(c.surf, LpShapes.Card)
            .border(1.dp, c.line, LpShapes.Card)
            .padding(padding)
            .let { if (description != null) it.semantics { contentDescription = description } else it },
        content = content,
    )
}

/** Small grey card heading (e.g. "Today's sales") with an optional value on the right. */
@Composable
fun CardLabel(text: String, modifier: Modifier = Modifier, trailing: (@Composable () -> Unit)? = null) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Bottom) {
        Text(text, style = LpType.Label, color = Lp.colors.soft, modifier = Modifier.weight(1f, fill = false).semantics { heading() })
        if (trailing != null) { Spacer(Modifier.width(LpSpacing.S)); trailing() }
    }
}

/** The big figure of a stat ($2,418, 78%). */
@Composable
fun BigValue(text: String, modifier: Modifier = Modifier, compact: Boolean = false, color: Color = Lp.colors.fg) {
    Text(text, modifier, style = if (compact) LpType.BigCompact else LpType.Big, color = color, maxLines = 1)
}

/** Label above a big value, optional supporting content below it. */
@Composable
fun StatBlock(label: String, value: String, modifier: Modifier = Modifier, supporting: (@Composable () -> Unit)? = null) {
    Column(modifier) {
        CardLabel(label)
        BigValue(value)
        supporting?.invoke()
    }
}

enum class Tone { Neutral, Good, Warn, Info, Lilac, Teal, Accent }

@Composable
fun Tone.fg(): Color = with(Lp.colors) { when (this@fg) { Tone.Neutral -> soft; Tone.Good -> good; Tone.Warn -> warn; Tone.Info -> info; Tone.Lilac -> lilac; Tone.Teal -> teal; Tone.Accent -> onAccSoft } }

@Composable
fun Tone.bg(): Color = with(Lp.colors) { when (this@bg) { Tone.Neutral -> surf3; Tone.Good -> goodBg; Tone.Warn -> warnBg; Tone.Info -> infoBg; Tone.Lilac -> lilacBg; Tone.Teal -> tealBg; Tone.Accent -> accSoft } }

/** A tag/chip: words plus (optionally) an icon, on a tinted background. Never colour alone. */
@Composable
fun LpChip(text: String, modifier: Modifier = Modifier, tone: Tone = Tone.Neutral, icon: ImageVector? = null) {
    Row(
        modifier.background(tone.bg(), LpShapes.Pill).padding(start = if (icon != null) 7.dp else 10.dp, end = 10.dp, top = 3.dp, bottom = 3.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (icon != null) LpIcon(icon, null, size = 20.dp, tint = tone.fg())
        Text(text, style = LpType.Chip, color = tone.fg(), maxLines = 1)
    }
}

/** The sales-per-labor-hour state in words with an icon. On/Over target are positive, Under target is the caution. */
@Composable
fun TargetChip(state: TargetState, modifier: Modifier = Modifier) = when (state) {
    TargetState.Under -> LpChip(state.label, modifier, Tone.Warn, LpIcons.TrendDown)
    TargetState.On -> LpChip(state.label, modifier, Tone.Good, LpIcons.Check)
    TargetState.Over -> LpChip(state.label, modifier, Tone.Good, LpIcons.TrendUp)
}

/** A coloured dot that always has its words next to it. */
@Composable
fun LpDot(color: Color, modifier: Modifier = Modifier, size: Dp = 10.dp) {
    Box(modifier.size(size).clip(CircleShape).background(color))
}

/** A 48dp-minimum tappable icon. [contentDescription] is required: TalkBack reads it. */
@Composable
fun LpIconButton(icon: ImageVector, contentDescription: String, onClick: () -> Unit, modifier: Modifier = Modifier, rotation: Float = 0f, tint: Color = Lp.colors.fg) {
    Box(
        modifier.size(LpSpacing.Touch).clip(CircleShape).clickable(role = Role.Button, onClickLabel = null, onClick = onClick)
            .semantics { this.contentDescription = contentDescription },
        contentAlignment = Alignment.Center,
    ) { LpIcon(icon, null, Modifier.rotate(rotation), tint = tint) }
}

/** Filled (coral/purple) or tonal pill button, 48dp high. */
@Composable
fun PillButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, tonal: Boolean = false, icon: ImageVector? = null) {
    val c = Lp.colors
    Row(
        modifier.heightIn(min = LpSpacing.Touch).clip(LpShapes.Pill).background(if (tonal) c.accSoft else c.acc)
            .clickable(role = Role.Button, onClick = onClick).padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
    ) {
        if (icon != null) LpIcon(icon, null, size = 20.dp, tint = if (tonal) c.onAccSoft else c.onAcc)
        Text(text, style = LpType.BodyStrong, color = if (tonal) c.onAccSoft else c.onAcc, maxLines = 1)
    }
}

/** List row: leading icon/content, title with optional supporting line, trailing content. 56dp minimum; tappable when [onClick] is given. */
@Composable
fun LpListRow(
    title: String,
    modifier: Modifier = Modifier,
    supporting: String? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
    onClick: (() -> Unit)? = null,
    selected: Boolean = false,
) {
    val c = Lp.colors
    Row(
        modifier.fillMaxWidth().heightIn(min = 56.dp).clip(LpShapes.Row)
            .background(if (selected) c.accSoft else Color.Transparent)
            .let { if (onClick != null) it.clickable(role = Role.Button, onClick = onClick) else it }
            .semantics { this.selected = selected }
            .padding(horizontal = LpSpacing.L, vertical = LpSpacing.S),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LpSpacing.M),
    ) {
        leading?.invoke()
        Column(Modifier.weight(1f)) {
            Text(title, style = LpType.Body, color = if (selected) c.onAccSoft else c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (supporting != null) Text(supporting, style = LpType.Small, color = c.soft, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        trailing?.invoke(this)
    }
}

/** A row with a switch. The whole row toggles; TalkBack reads "title, on/off". */
@Composable
fun SwitchRow(title: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit, modifier: Modifier = Modifier, supporting: String? = null) {
    val c = Lp.colors
    LpListRow(
        title = title, supporting = supporting,
        modifier = modifier.semantics(mergeDescendants = true) { role = Role.Switch; stateDescription = if (checked) "On" else "Off" },
        onClick = { onCheckedChange(!checked) },
        trailing = {
            Switch(
                checked = checked, onCheckedChange = null,
                colors = SwitchDefaults.colors(
                    checkedThumbColor = c.onAcc, checkedTrackColor = c.acc, checkedBorderColor = c.acc,
                    uncheckedThumbColor = c.outline, uncheckedTrackColor = c.surf3, uncheckedBorderColor = c.outline,
                ),
            )
        },
    )
}

/** `[-]  3 days  [+]` with 48dp buttons. [unit] is shown after the value ("days"). Clamped to [min]..[max]. */
@Composable
fun Stepper(value: Int, onValueChange: (Int) -> Unit, modifier: Modifier = Modifier, min: Int = 1, max: Int = 99, unit: String? = null) {
    val c = Lp.colors
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LpSpacing.L)) {
        StepButton(LpIcons.Minus, "Decrease", enabled = value > min) { onValueChange((value - 1).coerceAtLeast(min)) }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(value.toString(), style = LpType.Big, color = c.fg)
            if (unit != null) Text(unit, style = LpType.Row, color = c.soft, modifier = Modifier.padding(bottom = 6.dp))
        }
        StepButton(LpIcons.Plus, "Increase", enabled = value < max) { onValueChange((value + 1).coerceAtMost(max)) }
    }
}

@Composable
private fun StepButton(icon: ImageVector, description: String, enabled: Boolean, onClick: () -> Unit) {
    val c = Lp.colors
    Box(
        Modifier.size(LpSpacing.Touch).clip(CircleShape).border(BorderStroke(1.5.dp, if (enabled) c.outline else c.line), CircleShape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) { LpIcon(icon, null, tint = if (enabled) c.fg else c.outline) }
}

// ---- notices and states -------------------------------------------------------------------------------------------------

/** The quiet "As of 4:12 PM" line: clock icon plus text. [warn] tints it for "behind". */
@Composable
fun AsOfLine(text: String, modifier: Modifier = Modifier, warn: Boolean = false) {
    val color = if (warn) Lp.colors.warn else Lp.colors.soft
    Row(modifier.heightIn(min = 28.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        LpIcon(LpIcons.Clock, null, size = 20.dp, tint = color)
        Text(text, style = LpType.Small, color = color, maxLines = 2)
    }
}

/**
 * The banner for stale / offline / couldn't-refresh: a 48dp-minimum line with an icon, the words, and an optional action (Retry).
 * [warn] draws the amber edge; the icon and words carry the meaning, not the colour.
 */
@Composable
fun NoticeLine(text: String, icon: ImageVector, modifier: Modifier = Modifier, warn: Boolean = false, actionLabel: String? = null, onAction: (() -> Unit)? = null) {
    val c = Lp.colors
    val edge = if (warn) c.warn else c.outline
    Row(
        modifier.heightIn(min = LpSpacing.Touch).clip(LpShapes.Notice).background(c.surf3)
            .drawBehind { drawRect(edge, Offset.Zero, Size(4.dp.toPx(), size.height)) }
            .padding(start = 18.dp, end = 14.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        LpIcon(icon, null, tint = if (warn) c.warn else c.fg)
        Text(text, style = LpType.BodyStrong, color = c.fg, modifier = Modifier.weight(1f))
        if (actionLabel != null && onAction != null) PillButton(actionLabel, onAction, tonal = true)
    }
}

/** Centred "Couldn't load" style block with a button. */
@Composable
fun StateMessage(text: String, modifier: Modifier = Modifier, actionLabel: String? = null, onAction: (() -> Unit)? = null) {
    Column(modifier.fillMaxWidth().padding(horizontal = LpSpacing.L, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(LpSpacing.L)) {
        Text(text, style = LpType.Row.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), color = Lp.colors.fg)
        if (actionLabel != null && onAction != null) PillButton(actionLabel, onAction)
    }
}

/** A placeholder block while loading. Pulses unless the system animations are off. */
@Composable
fun Skeleton(modifier: Modifier = Modifier, width: Dp? = null, height: Dp = 14.dp, shape: Shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp)) {
    val transition = rememberInfiniteTransition(label = "skeleton")
    val a by transition.animateFloat(
        initialValue = 1f, targetValue = 1f, label = "pulse",
        animationSpec = infiniteRepeatable(keyframes { durationMillis = 1400; 1f at 0; 0.45f at 700; 1f at 1400 }, RepeatMode.Restart),
    )
    Box(modifier.let { if (width != null) it.width(width) else it }.height(height).alpha(a).background(Lp.colors.surf3, shape))
}

// ---- sheets and dialogs ----------------------------------------------------------------------------------------------------

/** Modal bottom sheet in the app's look. Content gets a 16dp inset. */
@Composable
fun LpBottomSheet(onDismiss: () -> Unit, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = Lp.colors
    ModalBottomSheet(
        onDismissRequest = onDismiss, modifier = modifier, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = c.surf, contentColor = c.fg, scrimColor = c.shade, shape = LpShapes.Sheet,
        content = { Column(Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, bottom = 16.dp), content = content) },
    )
}

/** A radio-style row for choosers (store menu, quiet hours, etc.). */
@Composable
fun ChoiceRow(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    LpListRow(
        title = text, modifier = modifier.semantics { role = Role.RadioButton }, selected = selected, onClick = onClick,
        trailing = { if (selected) LpIcon(LpIcons.Check, null, tint = Lp.colors.onAccSoft) },
    )
}

/** Centred dialog in the app's look (used for the threshold editor and unlock on wide screens). */
@Composable
fun LpDialog(onDismiss: () -> Unit, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Dialog(onDismissRequest = onDismiss) {
        Column(modifier.background(Lp.colors.surf, LpShapes.Card).border(1.dp, Lp.colors.line, LpShapes.Card).padding(LpSpacing.L), content = content)
    }
}

/** Context helper for components that need to know whether animations are off. */
@Composable
fun animationsEnabled(): Boolean {
    val resolver = LocalContext.current.contentResolver
    return android.provider.Settings.Global.getFloat(resolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f
}
