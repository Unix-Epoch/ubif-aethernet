package dev.aethernet.linkpearl.feature.alerts

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpDot
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.Tone
import dev.aethernet.linkpearl.core.design.bg
import dev.aethernet.linkpearl.core.design.fg

/** Icons core/design does not have (same 24-unit outline style). Kept here because core/design is not this package's to edit. */
object AlertIcons {
    private fun icon(name: String, vararg paths: String): ImageVector {
        val b = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
        paths.forEach { d ->
            b.addPath(
                pathData = PathParser().parsePathString(d).toNodes(), fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round,
            )
        }
        return b.build()
    }

    val Calendar = icon("calendar", "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4")
    val Package = icon("package", "M12 3l8 4.5v9L12 21l-8-4.5v-9z", "M4 7.5l8 4.5 8-4.5M12 12v9")
    val BellOff = icon("bellOff", "M6 8a6 6 0 0 1 9.5-4.9M18 11c0 5 3 6 3 6H8M10.3 21a1.94 1.94 0 0 0 3.4 0", "M3 3l18 18")
}

fun AlertType.icon(): ImageVector = when (this) {
    AlertType.Stuck -> LpIcons.Hourglass
    AlertType.Pickup -> AlertIcons.Package
    AlertType.Followup -> AlertIcons.Calendar
    AlertType.Quiet -> LpIcons.Clock
    AlertType.Back -> LpIcons.Check
}

fun AlertType.tone(): Tone = when (this) {
    AlertType.Stuck -> Tone.Warn
    AlertType.Pickup -> Tone.Good
    AlertType.Followup -> Tone.Info
    AlertType.Quiet -> Tone.Warn
    AlertType.Back -> Tone.Teal
}

/** The round per-type icon. The icon shape differs per type, so colour is not the only cue. */
@Composable
fun TypeBadge(type: AlertType, modifier: Modifier = Modifier, size: Dp = 44.dp) {
    Box(modifier.size(size).clip(CircleShape).background(type.tone().bg()), contentAlignment = Alignment.Center) {
        LpIcon(type.icon(), null, size = 24.dp, tint = type.tone().fg())
    }
}

/**
 * One feed row. Unread = bold text + a dot before the store line + a coloured edge on the left (three cues, not colour alone).
 * [shape] rounds the first and last rows of a day's card.
 */
@Composable
fun AlertRow(
    alert: Alert,
    names: Map<Int, String>,
    shape: Shape,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Lp.colors
    val sentence = AlertText.sentence(alert, names)
    val meta = AlertText.meta(alert, names)
    Row(
        modifier.fillMaxWidth().heightIn(min = 72.dp).clip(shape)
            .background(if (selected) c.accSoft else c.surf)
            .drawBehind { if (!alert.read) drawRect(c.acc, Offset.Zero, Size(4.dp.toPx(), size.height)) }
            .clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = (if (alert.read) "" else "Unread. ") + "$sentence. $meta" }
            .padding(start = 18.dp, end = 12.dp, top = 12.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        TypeBadge(alert.type)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                sentence, style = if (alert.read) LpType.Body else LpType.BodyStrong.copy(fontWeight = FontWeight.Bold),
                color = if (selected) c.onAccSoft else c.fg, maxLines = 3, overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!alert.read) LpDot(c.acc, size = 8.dp)
                Text(meta, style = LpType.Small, color = c.soft, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        LpIcon(LpIcons.ChevronRight, null, tint = c.soft)
    }
}

/** `3 days ✎` : the tappable threshold chip (48dp touch target, a smaller pill drawn inside). */
@Composable
fun ValueChip(text: String, onClick: () -> Unit, description: String, modifier: Modifier = Modifier) {
    val c = Lp.colors
    Box(
        modifier.heightIn(min = LpSpacing.Touch).clickable(role = Role.Button, onClick = onClick).semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        Row(
            Modifier.background(c.surf3, LpShapes.Pill).padding(horizontal = 14.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(text, style = LpType.BodyStrong, color = c.fg, maxLines = 1)
            LpIcon(LpIcons.Edit, null, size = 20.dp, tint = c.fg)
        }
    }
}

@Composable
fun LpSwitch(checked: Boolean, onCheckedChange: (Boolean) -> Unit, label: String, modifier: Modifier = Modifier) {
    val c = Lp.colors
    Box(
        modifier.heightIn(min = LpSpacing.Touch).semantics { role = Role.Switch; stateDescription = if (checked) "On" else "Off"; contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Switch(
            checked = checked, onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = c.onAcc, checkedTrackColor = c.acc, checkedBorderColor = c.acc,
                uncheckedThumbColor = c.outline, uncheckedTrackColor = c.surf3, uncheckedBorderColor = c.outline,
            ),
        )
    }
}

/** A type's row: badge, name, threshold chip, switch. Used in Alert settings and in the alert detail card. */
@Composable
fun TypeSettingRow(type: AlertType, setting: TypeSetting, onToggle: (Boolean) -> Unit, onEditValue: () -> Unit, modifier: Modifier = Modifier) {
    val c = Lp.colors
    Row(
        modifier.fillMaxWidth().heightIn(min = 72.dp).padding(horizontal = LpSpacing.L, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        TypeBadge(type, size = 40.dp)
        Text(type.label, style = LpType.BodyStrong, color = c.fg, modifier = Modifier.weight(1f), maxLines = 2)
        ValueChip(thresholdText(type, setting.value), onEditValue, "${type.label} threshold, ${thresholdText(type, setting.value)}")
        LpSwitch(setting.on, onToggle, type.label)
    }
}

fun thresholdText(type: AlertType, v: Int): String = when (type) {
    AlertType.Stuck, AlertType.Pickup -> AlertText.days(v)
    AlertType.Followup -> AlertText.hourOfDay(v)
    AlertType.Quiet -> AlertText.hours(v)
    AlertType.Back -> ""
}

/** A grouped card of rows with hairline dividers between them. */
@Composable
fun GroupCard(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val c = Lp.colors
    Column(modifier.fillMaxWidth().clip(LpShapes.Card).background(c.surf).border(1.dp, c.line, LpShapes.Card)) { content() }
}

@Composable
fun Hairline() {
    Box(Modifier.fillMaxWidth().height(1.dp).background(Lp.colors.line))
}
