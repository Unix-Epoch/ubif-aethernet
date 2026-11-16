package dev.aethernet.linkpearl.feature.workorders

import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpBottomSheet
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIconButton
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.NoticeLine
import dev.aethernet.linkpearl.core.design.PillButton
import dev.aethernet.linkpearl.core.design.Skeleton
import dev.aethernet.linkpearl.core.design.pressScale
import dev.aethernet.linkpearl.core.design.rememberHaptics
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * Screenshots draw the sheets inside the screen (a modal sheet is its own window, which a JVM render does not capture). The app
 * always uses the modal sheet.
 */
val LocalWoInlineSheets = staticCompositionLocalOf { false }

/** The dashed add / change chip after the tag and follow-up chips (only on an open work order). */
@Composable
fun DashedChip(text: String, icon: ImageVector, onClick: () -> Unit, modifier: Modifier = Modifier, description: String = text) {
    val c = Lp.colors
    val interaction = remember { MutableInteractionSource() }
    val ink = if (c.isDark) c.onAccSoft else c.acc
    Row(
        modifier.heightIn(min = 34.dp).pressScale(interaction).clip(LpShapes.Pill)
            .drawBehind {
                val r = size.height / 2
                drawRoundRect(c.outline, style = Stroke(1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(7.dp.toPx(), 5.dp.toPx()))), cornerRadius = CornerRadius(r))
            }
            .clickable(interaction, LocalIndication.current, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = description }
            .padding(start = 10.dp, end = 14.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        LpIcon(icon, null, size = 18.dp, tint = ink)
        Text(text, style = LpType.Chip, color = ink, maxLines = 1)
    }
}

/** A sheet: the modal bottom sheet in the app, drawn in place for screenshots. Title row with a close button, then [content]. */
@Composable
fun WoSheet(title: String, onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val body: @Composable ColumnScope.() -> Unit = {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(title, style = LpType.Title.copy(fontWeight = FontWeight.Bold), color = Lp.colors.fg, modifier = Modifier.weight(1f).semantics { heading() })
            LpIconButton(LpIcons.Close, "Close", onDismiss)
        }
        content()
    }
    if (LocalWoInlineSheets.current) InlineSheet(onDismiss, body) else LpBottomSheet(onDismiss, content = body)
}

@Composable
private fun InlineSheet(onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val c = Lp.colors
    Box(Modifier.fillMaxSize().background(c.shade).clickable(onClickLabel = "Close", onClick = onDismiss), contentAlignment = Alignment.BottomCenter) {
        Column(
            Modifier.widthIn(max = 640.dp).fillMaxWidth().background(c.surf, LpShapes.Sheet).clickable(enabled = false) {}
                .padding(start = 8.dp, end = 8.dp, top = 12.dp, bottom = 24.dp),
        ) {
            Box(Modifier.align(Alignment.CenterHorizontally).padding(bottom = 16.dp).size(32.dp, 4.dp).background(c.soft.copy(alpha = 0.6f), LpShapes.Pill))
            content()
        }
    }
}

// ---- Tags ------------------------------------------------------------------------------------------------------------------

@Composable
fun TagsSheet(state: WoDetailUi, actions: WoDetailActions) {
    val sheet = state.tagsSheet ?: return
    val c = Lp.colors
    val haptics = rememberHaptics()
    val on = state.detail?.wo?.tags.orEmpty()
    WoSheet("Tags", actions.onCloseTags) {
        Column(Modifier.fillMaxWidth().heightIn(max = 460.dp).verticalScroll(rememberScrollState())) {
            when {
                sheet.loading && sheet.managed == null -> repeat(3) { Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) { Skeleton(width = 160.dp, height = 18.dp) } }
                sheet.failed && sheet.managed == null -> NoticeLine(problemText(Problem.Server), LpIcons.Warning, Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp), warn = true, actionLabel = "Retry", onAction = actions.onRetryTags)
            }
            val rows = WaymarkTags.rows(sheet.managed.orEmpty(), on)
            rows.forEachIndexed { i, r ->
                if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(c.line))
                TagSheetRow(r) { haptics.toggle(!r.on); actions.onToggleTag(r.name, !r.on) }
            }
        }
        if (sheet.oneOff) {
            Spacer(Modifier.height(12.dp))
            NewTagField(sheet.maxLength, onAdd = { haptics.toggle(true); actions.onAddTag(it) })
        }
    }
}

@Composable
private fun TagSheetRow(r: TagRowUi, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val c = Lp.colors
    Row(
        modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(role = Role.Checkbox, onClick = onClick)
            .semantics { toggleableState = if (r.on) ToggleableState.On else ToggleableState.Off }.padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        val dot = r.color?.let { TagColors.parse(it) }
        if (dot != null) Box(Modifier.size(14.dp).clip(CircleShape).background(dot))
        else Box(Modifier.size(14.dp).border(2.dp, c.soft, CircleShape))
        Text(r.name, style = LpType.Row, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (r.on) LpIcon(LpIcons.Check, null, tint = if (c.isDark) c.onAccSoft else c.acc)
    }
}

@Composable
private fun NewTagField(maxLength: Int, onAdd: (String) -> Unit) {
    val c = Lp.colors
    var text by remember { mutableStateOf("") }
    val submit = { val t = text.trim(); if (t.isNotEmpty()) { onAdd(t); text = "" } }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp).heightIn(min = 56.dp).background(c.surf3, LpShapes.Pill).padding(start = 18.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        LpIcon(LpIcons.Plus, null, tint = c.soft)
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (text.isEmpty()) Text("New tag", style = LpType.Row, color = c.soft, maxLines = 1)
            BasicTextField(
                value = text, onValueChange = { text = it.take(maxLength) }, singleLine = true,
                textStyle = LpType.Row.copy(color = c.fg), cursorBrush = SolidColor(c.acc),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = "New tag" },
            )
        }
        if (text.isNotBlank()) LpIconButton(LpIcons.Check, "Add tag", { submit() })
    }
}

// ---- Follow-up -------------------------------------------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FollowUpSheet(state: WoDetailUi, today: LocalDate, actions: WoDetailActions) {
    val sheet = state.followSheet ?: return
    val due = FollowUpDates.parse(state.detail?.wo?.followUp?.due) ?: return
    val c = Lp.colors
    val haptics = rememberHaptics()
    var picking by remember { mutableStateOf(false) }
    val quick = FollowUpDates.QUICK.map { it to FollowUpDates.push(today, due, it) }
    val custom = sheet.choice?.takeIf { ch -> quick.none { it.second == ch } }
    WoSheet("Follow-up", actions.onCloseFollowUp) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val overdue = due < today
            val tone = when { overdue -> c.warn; due == today -> c.info; else -> c.fg }
            Row(
                Modifier.fillMaxWidth().heightIn(min = 56.dp).background(if (overdue) c.warnBg else if (due == today) c.infoBg else c.surf3, LpShapes.Row).padding(horizontal = 18.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                LpIcon(if (overdue) LpIcons.Warning else LpIcons.Calendar, null, tint = tone)
                Text(FollowUpDates.stateLabel(due, today), style = LpType.Row.copy(fontWeight = FontWeight.Bold), color = tone, maxLines = 1)
            }
            val latest = FollowUpDates.latest(today)
            // +1 / +3 on the first row, +7 and Date on the second
            for (rowIndex in 0..1) {
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    for (i in rowIndex * 2 until rowIndex * 2 + 2) {
                        val m = Modifier.weight(1f).fillMaxHeight()
                        if (i < quick.size) {
                            val (n, day) = quick[i]
                            ChoiceTile(FollowUpDates.quickLabel(n), FollowUpDates.dayLabel(day), null, sheet.choice == day, day <= latest, m) { haptics.tick(); actions.onPickFollowUp(day) }
                        } else {
                            ChoiceTile("Date", custom?.let { FollowUpDates.dayLabel(it) }, LpIcons.Calendar, custom != null, true, m) { picking = true }
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlineButton(
                    if (sheet.confirmRemove) "Confirm remove" else "Remove", LpIcons.Trash, { if (!sheet.saving) actions.onRemoveFollowUp() },
                    Modifier.weight(0.9f).heightIn(min = 56.dp), tint = c.warn, filled = false, fill = if (sheet.confirmRemove) c.warnBg else null,
                )
                val canSave = sheet.choice != null && !sheet.saving
                PillButton(
                    "Save", { if (canSave) { haptics.confirm(); actions.onSaveFollowUp() } },
                    Modifier.weight(1.1f).heightIn(min = 56.dp).alpha(if (canSave) 1f else 0.45f).semantics { if (!canSave) stateDescription = "Disabled" },
                )
            }
        }
    }
    if (picking) {
        val earliest = FollowUpDates.earliest(today, due)
        val latest = FollowUpDates.latest(today)
        val millis = { d: LocalDate -> d.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() }
        val picker = rememberDatePickerState(
            initialSelectedDateMillis = millis(sheet.choice ?: earliest), initialDisplayedMonthMillis = millis(sheet.choice ?: earliest),
            yearRange = today.year..latest.year,
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long): Boolean {
                    val d = Instant.ofEpochMilli(utcTimeMillis).atZone(ZoneOffset.UTC).toLocalDate()
                    return d in earliest..latest
                }
                override fun isSelectableYear(year: Int): Boolean = year in today.year..latest.year
            },
        )
        DatePickerDialog(
            onDismissRequest = { picking = false },
            confirmButton = {
                TextButton(onClick = {
                    picker.selectedDateMillis?.let { ms -> actions.onPickFollowUp(Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate()) }
                    picking = false
                }) { Text("OK", style = LpType.BodyStrong) }
            },
            dismissButton = { TextButton(onClick = { picking = false }) { Text("Cancel", style = LpType.BodyStrong) } },
        ) { DatePicker(picker, showModeToggle = false) }
    }
}

/** One choice of the Follow-up sheet: "+3 days" over "Tue, Nov 18" (or the Date button), outlined, filled when picked. */
@Composable
private fun ChoiceTile(title: String, sub: String?, icon: ImageVector?, selected: Boolean, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = Lp.colors
    val interaction = remember { MutableInteractionSource() }
    val shape = RoundedCornerShape(24.dp)
    val ink = if (selected) c.onAccSoft else c.fg
    Column(
        modifier.heightIn(min = 72.dp).alpha(if (enabled) 1f else 0.4f).pressScale(interaction).clip(shape)
            .let { if (selected) it.background(c.accSoft) else it.border(1.5.dp, c.outline, shape) }
            .clickable(interaction, LocalIndication.current, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .semantics { this.selected = selected }.padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (icon != null) LpIcon(icon, null, size = 22.dp, tint = ink)
            Text(title, style = LpType.Row.copy(fontWeight = FontWeight.Bold), color = ink, maxLines = 1)
        }
        if (sub != null) Text(sub, style = LpType.Body, color = if (selected) ink else c.soft, maxLines = 1)
    }
}

// ---- snackbar --------------------------------------------------------------------------------------------------------------

/** A short line at the bottom for a few seconds (a change that did not save). */
@Composable
fun BoxScope.WoSnackbar(message: String?, onShown: () -> Unit, bottom: androidx.compose.ui.unit.Dp = 96.dp) {
    if (message == null) return
    val c = Lp.colors
    LaunchedEffect(message) { delay(3500); onShown() }
    Row(
        Modifier.align(Alignment.BottomCenter).padding(start = LpSpacing.Gutter, end = LpSpacing.Gutter, bottom = bottom).widthIn(max = 560.dp)
            .background(c.fg, LpShapes.Row).semantics { liveRegion = LiveRegionMode.Polite }.padding(horizontal = 18.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        LpIcon(LpIcons.Warning, null, size = 20.dp, tint = c.page)
        Text(message, style = LpType.BodyStrong, color = c.page, maxLines = 2)
    }
}
