package dev.aethernet.linkpearl.feature.alerts

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpDialog
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIconButton
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.Fmt
import dev.aethernet.linkpearl.core.design.NoticeLine
import dev.aethernet.linkpearl.core.design.PillButton
import dev.aethernet.linkpearl.core.design.Skeleton
import dev.aethernet.linkpearl.core.design.StateMessage
import dev.aethernet.linkpearl.core.design.SwitchRow

private sealed interface Editing {
    data class Threshold(val type: AlertType) : Editing
    data object From : Editing
    data object To : Editing
}

/**
 * Alert settings: a switch and an editable threshold per type, quiet hours, a switch per store. No descriptions under the rows.
 * [editorStyle] is Sheet on phones and Dialog on wide screens. [initialEditing] opens the threshold editor at once (screenshots).
 */
@Composable
fun AlertSettingsScreen(
    ui: SettingsUi,
    names: Map<Int, String>,
    storeIds: List<Int>,
    onEdit: (SettingsEdit) -> Unit,
    onBack: (() -> Unit)?,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    editorStyle: EditorStyle = EditorStyle.Sheet,
    initialEditing: AlertType? = null,
) {
    val c = Lp.colors
    var editing by remember { mutableStateOf<Editing?>(initialEditing?.let { Editing.Threshold(it) }) }
    Box(modifier.fillMaxSize()) {
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) LpIconButton(LpIcons.Back, "Back", onBack)
            else Spacer(Modifier.padding(start = 12.dp))
            Text("Alert settings", style = LpType.Title, color = c.fg, modifier = Modifier.padding(start = 4.dp).semantics { heading() })
        }
        when (ui) {
            SettingsUi.Loading -> Column(Modifier.padding(LpSpacing.Gutter), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                repeat(4) { Skeleton(Modifier.fillMaxWidth(), height = 64.dp, shape = LpShapes.Row) }
            }
            is SettingsUi.Failed -> StateMessage(if (ui.offline) "Offline" else "Couldn't load", actionLabel = "Retry", onAction = onRetry)
            is SettingsUi.Ready -> {
                val s = ui.bundle.settings
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = LpSpacing.Gutter), verticalArrangement = Arrangement.spacedBy(LpSpacing.L)) {
                    if (ui.error != null) NoticeLine(ui.error, LpIcons.Warning, warn = true)
                    GroupCard {
                        AlertType.configurableTypes.forEachIndexed { i, t ->
                            if (i > 0) Hairline()
                            val ts = s.types[t] ?: return@forEachIndexed
                            TypeSettingRow(t, ts, { onEdit(SettingsEdit.TypeOn(t, it)) }, { editing = Editing.Threshold(t) })
                        }
                    }
                    GroupCard {
                        SwitchRow("Quiet hours", s.quiet.on, { onEdit(SettingsEdit.QuietOn(it)) })
                        Hairline()
                        Row(Modifier.fillMaxWidth().padding(LpSpacing.M), horizontalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
                            TimeBox("From", s.quiet.from, Modifier.weight(1f)) { editing = Editing.From }
                            TimeBox("To", s.quiet.to, Modifier.weight(1f)) { editing = Editing.To }
                        }
                    }
                    Text("STORES", style = LpType.Label, color = c.soft, modifier = Modifier.padding(start = 8.dp).semantics { heading() })
                    GroupCard {
                        val ids = (storeIds.ifEmpty { s.stores.keys.toList() }).distinct()
                        ids.forEachIndexed { i, id ->
                            if (i > 0) Hairline()
                            Row(
                                Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(start = LpSpacing.L, end = LpSpacing.L),
                                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                LpIcon(LpIcons.Store, null, tint = c.soft)
                                Text(Fmt.storeLabel(id, names[id]), style = LpType.Row, color = c.fg, modifier = Modifier.weight(1f), maxLines = 2)
                                LpSwitch(s.stores[id] ?: true, { onEdit(SettingsEdit.StoreOn(id, it)) }, Fmt.storeLabel(id, names[id]))
                            }
                        }
                    }
                }
            }
        }
    }
    (ui as? SettingsUi.Ready)?.let { r ->
        val s = r.bundle.settings
        when (val e = editing) {
            is Editing.Threshold -> s.types[e.type]?.let { cur ->
                ThresholdEditor(e.type, cur.value, r.bundle.ranges.of(e.type), editorStyle,
                    onSave = { onEdit(SettingsEdit.TypeValue(e.type, it)); editing = null }, onDismiss = { editing = null })
            }
            Editing.From -> TimeDialog("From", s.quiet.from, onSave = { onEdit(SettingsEdit.QuietFrom(it)); editing = null }, onDismiss = { editing = null })
            Editing.To -> TimeDialog("To", s.quiet.to, onSave = { onEdit(SettingsEdit.QuietTo(it)); editing = null }, onDismiss = { editing = null })
            null -> {}
        }
    }
    }
}

@Composable
private fun TimeBox(label: String, hhmm: String, modifier: Modifier, onClick: () -> Unit) {
    val c = Lp.colors
    Row(
        modifier.heightIn(min = 56.dp).clip(LpShapes.Notice).border(1.5.dp, c.outline, LpShapes.Notice)
            .clickable(role = Role.Button, onClick = onClick).semantics(mergeDescendants = true) { contentDescription = "$label ${AlertText.clock24(hhmm)}" }
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = LpType.Body, color = c.soft)
        Text(AlertText.clock24(hhmm), style = LpType.BodyStrong, color = c.fg, maxLines = 1)
    }
}

@Composable
private fun TimeDialog(title: String, hhmm: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    val c = Lp.colors
    val (h, m) = hhmmParts(hhmm)
    val state = rememberTimePickerState(initialHour = h, initialMinute = m, is24Hour = false)
    LpDialog(onDismiss) {
        Text(title, style = LpType.Title, color = c.fg, modifier = Modifier.padding(bottom = 16.dp).semantics { heading() })
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { TimePicker(state) }
        Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(
                Modifier.weight(1f).heightIn(min = 52.dp).clip(LpShapes.Pill).border(1.5.dp, c.outline, LpShapes.Pill).clickable(role = Role.Button, onClick = onDismiss),
                contentAlignment = Alignment.Center,
            ) { Text("Cancel", style = LpType.BodyStrong, color = c.fg) }
            PillButton("Save", { onSave(toHhmm(state.hour, state.minute)) }, Modifier.weight(1f).heightIn(min = 52.dp))
        }
    }
}
