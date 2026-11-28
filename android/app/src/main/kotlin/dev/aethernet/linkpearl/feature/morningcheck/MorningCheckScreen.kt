package dev.aethernet.linkpearl.feature.morningcheck

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.ChoiceRow
import dev.aethernet.linkpearl.core.design.Fmt
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpBottomSheet
import dev.aethernet.linkpearl.core.design.LpCard
import dev.aethernet.linkpearl.core.design.LpChip
import dev.aethernet.linkpearl.core.design.LpHeroCard
import dev.aethernet.linkpearl.core.design.LpIconButton
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpSpacing
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.PillButton
import dev.aethernet.linkpearl.core.design.ProgressBar
import dev.aethernet.linkpearl.core.design.StateMessage
import dev.aethernet.linkpearl.core.design.Tone
import dev.aethernet.linkpearl.core.design.glass
import dev.aethernet.linkpearl.core.design.rememberHaptics
import dev.aethernet.linkpearl.core.nav.LocalNavInset
import dev.aethernet.linkpearl.feature.workorders.OutlineButton
import dev.aethernet.linkpearl.feature.workorders.StatusChip
import dev.aethernet.linkpearl.feature.workorders.LocalWoClock
import dev.aethernet.linkpearl.feature.workorders.NoteKind
import dev.aethernet.linkpearl.feature.workorders.WoFmt
import dev.aethernet.linkpearl.core.design.LpIcon

data class McActions(
    val onBack: () -> Unit = {},
    val onOrder: (McOrder) -> Unit = {},
    val onStart: () -> Unit = {},
    val onLooksRight: () -> Unit = {},
    val onSkip: () -> Unit = {},
    val onNext: () -> Unit = {},
    val onSave: (McChange) -> Unit = {},
    val onRetry: () -> Unit = {},
    val onScan: (String) -> Unit = {},
    val onCheckSkipped: () -> Unit = {},
    val onFinish: () -> Unit = {},
    val onAgain: () -> Unit = {},
    val onLinkshell: () -> Unit = {},
)

/** Portal's status → the Work orders lanes' colours (feature/workorders Lane). */
internal fun laneOf(statusId: Int): String = when (statusId) {
    2 -> "order"
    8, 24 -> "start"
    9, 10, 11, 12 -> "work"
    13 -> "rfp"
    else -> "wait"
}

/**
 * Morning check, stateless: pick the walking order and start; then one work order at a time with Looks right, Edit or Skip, a
 * work order label scanned with [camera] brings that order forward; a summary at the end.
 */
@Composable
fun MorningCheckScreen(
    state: McUi,
    actions: McActions = McActions(),
    modifier: Modifier = Modifier,
    camera: (@Composable (onCode: (String) -> Unit) -> Unit)? = null,
    startEditing: Boolean = false,
    startScanning: Boolean = false,
) {
    val navInset = LocalNavInset.current
    var editing by rememberSaveable { mutableStateOf(startEditing) }
    var scanning by rememberSaveable { mutableStateOf(startScanning) }
    val s = (state as? McUi.Checking)?.s
    Column(modifier.fillMaxSize()) {
        Header(s, actions.onBack, if (camera != null && s != null && !s.complete) ({ scanning = !scanning }) else null, scanning)
        Column(
            Modifier.weight(1f).fillMaxWidth().let { if (s != null && !s.complete) it else it.verticalScroll(rememberScrollState()) }
                .padding(horizontal = LpSpacing.Gutter).padding(bottom = LpSpacing.M),
            verticalArrangement = Arrangement.spacedBy(LpSpacing.M),
        ) {
            when (state) {
                McUi.NoLink -> StateMessage("No linked PC", actionLabel = "Linkshell", onAction = actions.onLinkshell)
                is McUi.Start -> StartBody(state, actions)
                is McUi.Waiting -> PcCard(state.pc, state.online)
                is McUi.Ended -> StateMessage(if (state.reason == "declined") "Declined on the PC" else "Stopped on the PC")
                is McUi.Checking -> if (state.s.complete) DoneBody(state.s) else CheckBody(state.s, if (scanning) camera else null, actions.onScan)
            }
        }
        val bottom = @Composable { content: @Composable () -> Unit ->
            Box(Modifier.fillMaxWidth().padding(horizontal = LpSpacing.Gutter).padding(top = 8.dp, bottom = 16.dp + navInset)) { content() }
        }
        when (state) {
            is McUi.Start -> bottom { PillButton("Start", actions.onStart, Modifier.fillMaxWidth()) }
            is McUi.Ended -> bottom { PillButton("Start again", actions.onAgain, Modifier.fillMaxWidth()) }
            is McUi.Checking -> bottom {
                val cur = state.s.current
                if (cur == null) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (state.s.count(McMark.Skipped) > 0) OutlineButton("Check skipped", null, actions.onCheckSkipped, Modifier.fillMaxWidth())
                    PillButton("Done", actions.onFinish, Modifier.fillMaxWidth())
                } else Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    when {
                        cur.sending != null -> PillButton("Saving", {}, Modifier.weight(1f), tonal = true)
                        cur.mark == McMark.Failed -> {
                            OutlineButton("Edit", null, { editing = true }, Modifier.weight(1f))
                            OutlineButton("Next", null, actions.onNext, Modifier.weight(1f))
                            PillButton("Try again", actions.onRetry, Modifier.weight(1f), tonal = true)
                        }
                        cur.mark == McMark.Changed -> {
                            OutlineButton("Edit", null, { editing = true }, Modifier.weight(1f))
                            PillButton("Next", actions.onNext, Modifier.weight(1f))
                        }
                        else -> {
                            OutlineButton("Skip", null, actions.onSkip, Modifier.weight(0.8f))
                            OutlineButton("Edit", null, { editing = true }, Modifier.weight(0.8f))
                            PillButton("Looks right", actions.onLooksRight, Modifier.weight(1.4f))
                        }
                    }
                }
            }
            else -> {}
        }
    }
    val cur = s?.current
    if (editing && cur != null && cur.sending == null) EditSheet(s, cur, onDismiss = { editing = false }, onSave = { editing = false; actions.onSave(it) })
}

@Composable
private fun Header(s: McSession?, onBack: () -> Unit, onCamera: (() -> Unit)?, scanning: Boolean) {
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = LpSpacing.Gutter - 4.dp, end = LpSpacing.Gutter, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        LpIconButton(LpIcons.Back, "Back", onBack, Modifier.padding(end = 4.dp))
        Text("Morning check", style = LpType.Screen, color = Lp.colors.fg, maxLines = 1, modifier = Modifier.weight(1f).semantics { heading() })
        if (onCamera != null) LpIconButton(if (scanning) LpIcons.Close else LpIcons.Camera, if (scanning) "Close camera" else "Scan work order", onCamera, Modifier.padding(end = 4.dp))
        if (s != null && !s.complete) Box(Modifier.glass().padding(horizontal = 12.dp, vertical = 6.dp)) {
            Text("${(s.idx ?: 0) + 1} / ${s.total}", style = LpType.Chip, color = Lp.colors.fg, maxLines = 1)
        }
    }
}

@Composable
private fun PcCard(pc: String, online: Boolean) {
    LpHeroCard {
        Text(pc.ifBlank { "PC" }, style = LpType.Title, color = Lp.colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(Modifier.padding(top = 10.dp)) { LpChip(if (online) "Connected" else "Away", tone = if (online) Tone.Good else Tone.Neutral) }
    }
}

@Composable
private fun ColumnScope.StartBody(state: McUi.Start, actions: McActions) {
    PcCard(state.pc, state.online)
    Text("Order", style = LpType.Label, color = Lp.colors.soft, modifier = Modifier.padding(start = 4.dp, top = 4.dp))
    LpCard(padding = 6.dp) { McOrder.entries.forEach { o -> ChoiceRow(o.label, o == state.order, { actions.onOrder(o) }) } }
}

// ---------------------------------------------------------------- one work order
@Composable
private fun ColumnScope.CheckBody(s: McSession, camera: (@Composable ((String) -> Unit) -> Unit)?, onScan: (String) -> Unit) {
    val c = Lp.colors
    val cur = s.current ?: return
    val haptics = rememberHaptics()
    LaunchedEffect(cur.mark, cur.failed) { if (cur.mark == McMark.Changed) haptics.confirm() else if (cur.mark == McMark.Failed) haptics.reject() }
    if (camera != null) Box(Modifier.fillMaxWidth().height(150.dp).clip(LpShapes.Card)) { camera(onScan) }
    if (s.note == McNote.NotOpen) Message("Not an open work order", null)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        ProgressBar(s.done.toFloat() / s.total.coerceAtLeast(1), c.acc, Modifier.weight(1f), growKey = "mc")
        if (s.count(McMark.Skipped) > 0) LpChip("${Fmt.count(s.count(McMark.Skipped))} skipped", tone = Tone.Warn)
    }
    Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(LpSpacing.M)) {
        OrderCard(s, cur)
        val next = ((s.idx ?: 0) + 1 until s.items.size).map { s.items[it] }.filter { it.mark == McMark.Pending }.take(3)
        next.forEach { NextRow(it) }
    }
}

@Composable
private fun OrderCard(s: McSession, it: McItem) {
    val c = Lp.colors
    val r = it.row
    LpCard {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(r.wo, style = LpType.Value, color = c.fg, modifier = Modifier.weight(1f))
            if (it.movedUp) LpChip("Moved up", tone = Tone.Info)
        }
        Text(listOf(r.device, r.issue, r.program).filter { t -> t.isNotBlank() }.joinToString(" · "), style = LpType.Body, color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (r.customer.isNotBlank()) Text(r.customer, style = LpType.Small, color = c.soft, maxLines = 1, modifier = Modifier.padding(top = 2.dp))
        Field("Location") {
            val was = it.was?.bin?.takeIf { b -> b != r.bin }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (was != null) Text(was.ifBlank { "None" }, style = LpType.ValueMedium.copy(textDecoration = TextDecoration.LineThrough), color = c.soft)
                Text(r.bin.ifBlank { "None" }, style = LpType.ValueMedium, color = if (r.bin.isBlank()) c.soft else c.accText)
            }
        }
        Field("Status") { StatusChip(s.statusName(r.statusId), laneOf(r.statusId), outcome = r.outcome) }
        Field("Nickname") { Text(r.nickname.ifBlank { "None" }, style = LpType.Body, color = if (r.nickname.isBlank()) c.soft else c.fg) }
        s.notes[r.wo]?.takeIf { n -> n.notes.isNotEmpty() }?.let { NotesPart(it) }
        when {
            it.sending != null -> Message("Saving", null)
            it.mark == McMark.Failed -> it.failed.forEach { (f, m) -> Message(failTitle(f), m, bad = true) }
            it.mark == McMark.Changed -> Message("Saved in Portal", null, good = true)
        }
    }
}

/** The order's notes, newest first: the newest [SHOWN], then all of them. */
@Composable
private fun NotesPart(n: McNotes) {
    val c = Lp.colors
    val zone = LocalWoClock.current.zone
    var all by remember(n.wo) { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Notes", style = LpType.Label, color = c.soft, modifier = Modifier.weight(1f))
        Text(Fmt.count(n.total), style = LpType.Label, color = c.soft)
    }
    (if (all) n.notes else n.notes.take(SHOWN)).forEach { note ->
        Box(Modifier.fillMaxWidth().padding(vertical = 10.dp).height(1.dp).background(c.line))
        val auto = note.kind == NoteKind.Automatic
        Text(note.text, style = LpType.Body, color = if (auto) c.soft else c.fg)
        Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (auto) LpIcon(LpIcons.Auto, null, size = 16.dp, tint = c.soft)
            Text(listOfNotNull(if (auto) "Auto" else null, note.author, WoFmt.shortDayTime(note.createdAt, zone)).joinToString(Fmt.DOT),
                style = LpType.Small, color = c.soft, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
    if (!all && n.notes.size > SHOWN) {
        Text("All ${Fmt.count(n.total)} notes", style = LpType.BodyStrong, color = c.accText,
            modifier = Modifier.padding(top = 8.dp).clip(LpShapes.Pill).clickable { all = true }.padding(vertical = 8.dp))
    }
}
private const val SHOWN = 2

private fun failTitle(field: String) = when (field) {
    "status" -> "Status not changed"
    "bin" -> "Location not changed"
    "nickname" -> "Nickname not changed"
    "note" -> "Note not added"
    else -> "Not changed"
}

@Composable
private fun Field(label: String, content: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = LpType.Label, color = Lp.colors.soft, modifier = Modifier.widthIn(min = 92.dp))
        Box(Modifier.weight(1f)) { content() }
    }
}

@Composable
private fun NextRow(it: McItem) {
    val c = Lp.colors
    Row(
        Modifier.fillMaxWidth().clip(LpShapes.Card).background(c.surf3).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(it.row.wo, style = LpType.BodyStrong, color = c.fg)
        Text(it.row.device, style = LpType.Small, color = c.soft, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text(it.row.bin, style = LpType.Label, color = c.accText, maxLines = 1)
    }
}

@Composable
private fun Message(title: String, detail: String?, bad: Boolean = false, good: Boolean = false) {
    val c = Lp.colors
    Column(Modifier.fillMaxWidth().padding(top = 12.dp).clip(LpShapes.Row).background(if (bad) c.warnBg else if (good) c.goodBg else c.surf3).padding(horizontal = 14.dp, vertical = 10.dp)) {
        Text(title, style = LpType.BodyStrong, color = if (bad) c.warn else if (good) c.good else c.fg)
        if (!detail.isNullOrBlank()) Text(detail, style = LpType.Small, color = c.fg)
    }
}

// ---------------------------------------------------------------- edit
@Composable
private fun EditSheet(s: McSession, it: McItem, onDismiss: () -> Unit, onSave: (McChange) -> Unit) {
    val c = Lp.colors
    val r = it.row
    var bin by remember(r.wo) { mutableStateOf(r.bin) }
    var status by remember(r.wo) { mutableStateOf(r.statusId) }
    var nickname by remember(r.wo) { mutableStateOf(r.nickname) }
    var note by remember(r.wo) { mutableStateOf("") }
    var picking by remember { mutableStateOf(false) }
    val moves = s.statuses[r.statusId]?.moves.orEmpty()
    LpBottomSheet(onDismiss) {
        if (picking) {
            Text("Status", style = LpType.Title, color = c.fg, modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp))
            (listOf(r.statusId) + moves).forEach { id -> ChoiceRow(s.statusName(id), id == status, { status = id; picking = false }) }
            return@LpBottomSheet
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(r.wo, style = LpType.Title, color = c.fg)
            if (s.bins) {
                Label("Location")
                TextBox(bin, { bin = it.take(40) }, "Location", KeyboardCapitalization.Characters)
                val quick = McSession.bins(s.items).filter { b -> b != bin }
                if (quick.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    quick.forEach { b -> Box(Modifier.clip(LpShapes.Pill).clickable(role = Role.Button) { bin = b }) { LpChip(b, tone = Tone.Accent) } }
                }
            }
            Label("Status")
            Row(
                Modifier.fillMaxWidth().heightIn(min = 52.dp).clip(LpShapes.Row).background(c.surf3)
                    .let { m -> if (moves.isNotEmpty()) m.clickable(role = Role.DropdownList) { picking = true } else m }.padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(s.statusName(status), style = LpType.Body, color = c.fg, modifier = Modifier.weight(1f))
                if (moves.isNotEmpty()) androidx.compose.material3.Icon(LpIcons.ChevronDown, null, tint = c.soft)
            }
            Label("Nickname")
            TextBox(nickname, { nickname = it.take(60) }, "Nickname")
            Label("Add note")
            TextBox(note, { note = it.take(2000) }, "Note", singleLine = false)
            Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlineButton("Cancel", null, onDismiss, Modifier.weight(1f))
                PillButton("Save", {
                    onSave(McChange(
                        status = status.takeIf { it != r.statusId },
                        bin = bin.trim().takeIf { s.bins && it != r.bin.trim() },
                        nickname = nickname.trim().takeIf { it != r.nickname.trim() },
                        note = note.trim().takeIf { it.isNotEmpty() },
                    ))
                }, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun Label(t: String) = Text(t, style = LpType.Label, color = Lp.colors.soft, modifier = Modifier.padding(start = 4.dp, top = 8.dp))

@Composable
private fun TextBox(value: String, onChange: (String) -> Unit, label: String, caps: KeyboardCapitalization = KeyboardCapitalization.Sentences, singleLine: Boolean = true) {
    val c = Lp.colors
    BasicTextField(
        value, onChange, singleLine = singleLine, minLines = if (singleLine) 1 else 2,
        textStyle = LpType.Body.copy(color = c.fg), cursorBrush = SolidColor(c.acc),
        keyboardOptions = KeyboardOptions(capitalization = caps, imeAction = if (singleLine) ImeAction.Done else ImeAction.Default),
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = label },
        decorationBox = { inner ->
            Box(Modifier.fillMaxWidth().heightIn(min = 52.dp).clip(LpShapes.Row).background(c.surf3).padding(horizontal = 16.dp, vertical = 14.dp), contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) Text(label, style = LpType.Body, color = c.soft)
                inner()
            }
        },
    )
}

// ---------------------------------------------------------------- done
@Composable
private fun ColumnScope.DoneBody(s: McSession) {
    val c = Lp.colors
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Stat(Fmt.count(s.done), "Checked", c.fg, Modifier.weight(1f))
        Stat(Fmt.count(s.count(McMark.Changed)), "Changed", c.warn, Modifier.weight(1f))
        Stat(Fmt.count(s.count(McMark.Failed)), "Failed", c.warn, Modifier.weight(1f))
        if (s.count(McMark.Skipped) > 0) Stat(Fmt.count(s.count(McMark.Skipped)), "Skipped", c.soft, Modifier.weight(1f))
    }
    s.items.filter { it.mark == McMark.Changed || it.mark == McMark.Failed || it.mark == McMark.Skipped }.forEach { it ->
        Row(
            Modifier.fillMaxWidth().clip(LpShapes.Row).background(c.surf3).padding(horizontal = 14.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(it.row.wo, style = LpType.BodyStrong, color = c.fg)
            Text(summary(s, it), style = LpType.Small, color = c.soft, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            when (it.mark) {
                McMark.Changed -> LpChip("Changed", tone = Tone.Good)
                McMark.Failed -> LpChip("Failed", tone = Tone.Warn)
                else -> LpChip("Skipped", tone = Tone.Neutral)
            }
        }
    }
}

/** What changed on a row, in a few words: new location, new status, "Nickname", "Note added". */
internal fun summary(s: McSession, it: McItem): String {
    val c = it.last ?: return it.row.bin
    return listOfNotNull(c.bin?.ifBlank { "No location" }, c.status?.let { s.statusName(it) }, c.nickname?.let { "Nickname" }, c.note?.let { "Note added" }).joinToString(" · ")
}

@Composable
private fun Stat(n: String, label: String, color: androidx.compose.ui.graphics.Color, modifier: Modifier) {
    Column(modifier.clip(LpShapes.Card).background(Lp.colors.surf3).padding(14.dp)) {
        Text(n, style = LpType.Value, color = color)
        Text(label, style = LpType.Label, color = Lp.colors.soft)
    }
}
