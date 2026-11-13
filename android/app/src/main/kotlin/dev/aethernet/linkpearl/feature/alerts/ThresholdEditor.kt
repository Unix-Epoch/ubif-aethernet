package dev.aethernet.linkpearl.feature.alerts

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpBottomSheet
import dev.aethernet.linkpearl.core.design.LpDialog
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.PillButton

/** Where the editor appears: a bottom sheet (phones), a dialog (wide settings screen) or centred in the detail pane (Fold inner screen). */
enum class EditorStyle { Sheet, Dialog, InPane, InlineSheet }

private fun quickValues(type: AlertType, range: IntRange): List<Int> =
    when (type) {
        AlertType.Stuck -> listOf(1, 2, 3, 5, 7)
        AlertType.Pickup -> listOf(3, 5, 7, 14, 21)
        AlertType.Followup -> listOf(7, 8, 9, 10, 12)
        AlertType.Quiet -> listOf(1, 2, 3, 4, 6)
        AlertType.Back -> emptyList()
    }.filter { it in range }

/** "9:00" and "AM" for the big value of the hour-of-day editor. */
fun hourParts(h: Int): Pair<String, String> = (if (h % 12 == 0) 12 else h % 12).toString() + ":00" to (if (h < 12) "AM" else "PM")

@Composable
fun ThresholdEditor(type: AlertType, current: Int, range: IntRange, style: EditorStyle, onSave: (Int) -> Unit, onDismiss: () -> Unit) {
    val content: @Composable () -> Unit = { ThresholdContent(type, current, range, onSave, onDismiss) }
    when (style) {
        EditorStyle.Sheet -> LpBottomSheet(onDismiss) { content() }
        EditorStyle.Dialog -> LpDialog(onDismiss) { content() }
        EditorStyle.InPane -> ThresholdInPane(onDismiss, content)
        EditorStyle.InlineSheet -> ThresholdInlineSheet(onDismiss, content)
    }
}

/** The pane-local overlay: dimmed pane, editor card in the middle. Tapping the dim area dismisses. */
@Composable
fun ThresholdInPane(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val c = Lp.colors
    Box(Modifier.fillMaxSize().background(c.shade).clickable(onClick = onDismiss), contentAlignment = Alignment.Center) {
        Column(
            Modifier.padding(LpSpacing.L).widthIn(max = 420.dp).background(c.surf, LpShapes.Card).border(1.dp, c.line, LpShapes.Card)
                .clickable(enabled = false) {}.padding(LpSpacing.L),
        ) { content() }
    }
}

/** Title, minus / value / plus, quick values, Cancel / Save. */
@Composable
fun ThresholdContent(type: AlertType, current: Int, range: IntRange, onSave: (Int) -> Unit, onCancel: () -> Unit) {
    val c = Lp.colors
    var value by remember(type, current) { mutableIntStateOf(current.coerceIn(range)) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalArrangement = Arrangement.spacedBy(LpSpacing.L)) {
        Text(type.label, style = LpType.Title, color = c.fg, modifier = Modifier.semantics { heading() })
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
            RoundStep(LpIcons.Minus, "Decrease", value > range.first, filled = false) { value = (value - 1).coerceAtLeast(range.first) }
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                val (big, unit) = when (type) {
                    AlertType.Followup -> hourParts(value)
                    AlertType.Quiet -> value.toString() to (if (value == 1) "hour" else "hours")
                    else -> value.toString() to (if (value == 1) "day" else "days")
                }
                Text(big, style = LpType.Big, color = c.fg, maxLines = 1)
                Text(unit, style = LpType.Row, color = c.soft, modifier = Modifier.padding(bottom = 6.dp), maxLines = 1)
            }
            RoundStep(LpIcons.Plus, "Increase", value < range.last, filled = true) { value = (value + 1).coerceAtMost(range.last) }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            quickValues(type, range).forEach { q ->
                QuickChip(if (type == AlertType.Followup) hourParts(q).let { "${it.first.removeSuffix(":00")} ${it.second}" } else q.toString(), q == value, Modifier.weight(1f)) { value = q }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(
                Modifier.weight(1f).heightIn(min = 52.dp).clip(LpShapes.Pill).border(1.5.dp, c.outline, LpShapes.Pill)
                    .clickable(role = Role.Button, onClick = onCancel),
                contentAlignment = Alignment.Center,
            ) { Text("Cancel", style = LpType.BodyStrong, color = c.fg) }
            PillButton("Save", { onSave(value) }, Modifier.weight(1f).heightIn(min = 52.dp))
        }
    }
}

@Composable
private fun RoundStep(icon: ImageVector, description: String, enabled: Boolean, filled: Boolean, onClick: () -> Unit) {
    val c = Lp.colors
    Box(
        Modifier.size(56.dp).clip(CircleShape).let { if (filled) it.background(c.accSoft, CircleShape) else it.border(BorderStroke(1.5.dp, if (enabled) c.outline else c.line), CircleShape) }
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) { LpIcon(icon, null, tint = if (!enabled) c.outline else if (filled) c.onAccSoft else c.fg) }
}

/** A quick value. Selected = filled, bold and a check mark in the semantics (not colour alone). */
@Composable
private fun QuickChip(text: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = Lp.colors
    val shape = LpShapes.Notice
    Box(
        modifier.heightIn(min = LpSpacing.Touch).clip(shape).background(if (selected) c.accSoft else androidx.compose.ui.graphics.Color.Transparent, shape)
            .border(if (selected) 2.dp else 1.5.dp, if (selected) c.onAccSoft else c.outline, shape)
            .clickable(role = Role.RadioButton, onClick = onClick).semantics { this.selected = selected },
        contentAlignment = Alignment.Center,
    ) { Text(text, style = LpType.Body, color = if (selected) c.onAccSoft else c.fg, fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal, maxLines = 1) }
}

/**
 * The bottom sheet drawn in the screen's own composition (same surface as [LpBottomSheet]). Screenshot tests use it because a real
 * ModalBottomSheet lives in its own window, which the JVM screenshot does not capture.
 */
@Composable
fun ThresholdInlineSheet(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val c = Lp.colors
    Box(Modifier.fillMaxSize().background(c.shade).clickable(onClick = onDismiss), contentAlignment = Alignment.BottomCenter) {
        Column(Modifier.fillMaxWidth().background(c.surf, LpShapes.Sheet).clickable(enabled = false) {}.padding(start = 8.dp, end = 8.dp, top = 24.dp, bottom = 24.dp)) { content() }
    }
}
