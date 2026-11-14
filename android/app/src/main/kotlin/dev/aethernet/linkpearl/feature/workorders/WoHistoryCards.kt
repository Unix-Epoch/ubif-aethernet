package dev.aethernet.linkpearl.feature.workorders

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.aethernet.linkpearl.core.design.CardLabel
import dev.aethernet.linkpearl.core.design.Fmt
import dev.aethernet.linkpearl.core.design.Lp
import dev.aethernet.linkpearl.core.design.LpCard
import dev.aethernet.linkpearl.core.design.LpChip
import dev.aethernet.linkpearl.core.design.LpIcon
import dev.aethernet.linkpearl.core.design.LpIcons
import dev.aethernet.linkpearl.core.design.LpShapes
import dev.aethernet.linkpearl.core.design.LpType
import dev.aethernet.linkpearl.core.design.Tone
import java.time.Instant
import java.time.LocalDate

// Closed work orders and Auto-Waymark pieces (design mock-ups): shared by the list cards and the detail.

/** The store-local day "YYYY-MM-DD" the clock is on. */
@Composable
fun todayLocal(nowMs: Long): String = LocalDate.ofInstant(Instant.ofEpochMilli(nowMs), LocalWoClock.current.zone).toString()

/** A tag: its list colour as a dot next to the name (the name always travels with the colour); a one-off tag has no dot, just an outline. */
@Composable
fun TagChip(tag: WoTag, modifier: Modifier = Modifier) {
    val c = Lp.colors
    val dot = tag.color?.let { TagColors.parse(it) }
    val base = if (dot != null) modifier.background(c.surf3, LpShapes.Pill) else modifier.border(1.5.dp, c.outline, LpShapes.Pill)
    Row(
        base.padding(start = if (dot != null) 10.dp else 12.dp, end = 12.dp, top = 3.dp, bottom = 3.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (dot != null) Box(Modifier.size(10.dp).clip(CircleShape).background(dot))
        Text(tag.tag, style = LpType.Chip, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** The due chip: Overdue with a warning mark and the day, Today with a clock, a later day plain. */
@Composable
fun DueChip(f: FollowUp, today: String, modifier: Modifier = Modifier) {
    when (f.state(today)) {
        DueState.Overdue -> LpChip("Overdue" + Fmt.DOT + f.day(), modifier, Tone.Warn, LpIcons.Warning)
        DueState.Today -> LpChip("Today", modifier, Tone.Info, LpIcons.Clock)
        DueState.Upcoming -> LpChip(f.day(), modifier, Tone.Neutral, LpIcons.Calendar)
    }
}

/** The follow-up marker: the rule, then when it is due. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun FollowUpMarker(f: FollowUp, today: String, modifier: Modifier = Modifier, longName: Boolean = false) {
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        LpChip(if (longName) f.rule.longLabel else f.rule.label, tone = Tone.Accent, icon = LpIcons.Calendar)
        DueChip(f, today)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TagRow(tags: List<WoTag>, modifier: Modifier = Modifier) {
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { tags.forEach { TagChip(it) } }
}

/** Closed outcome in words with an icon: `service_outcome`, else how it closed (`closed_reason`: the status it closed on). */
@Composable
fun OutcomeChip(outcome: String?, closedReason: String?, modifier: Modifier = Modifier) {
    when {
        outcome.equals("Completed", true) -> LpChip(outcome!!, modifier, Tone.Good, LpIcons.Check)
        outcome.equals("Incomplete", true) -> LpChip(outcome!!, modifier, Tone.Warn, LpIcons.Warning)
        outcome.equals("Declined", true) -> LpChip(outcome!!, modifier, Tone.Neutral, LpIcons.Close)
        outcome != null -> LpChip(outcome, modifier, Tone.Info, LpIcons.Search)
        closedReason != null -> LpChip(closedReason.replaceFirstChar { it.uppercase() }, modifier, Tone.Neutral, LpIcons.Check)
        else -> LpChip(Fmt.DASH, modifier, Tone.Neutral)
    }
}

/** A closed work order card: number and closed date; device and program; outcome and sold value; the customer line. */
@Composable
fun ClosedWoCard(row: WoRow, state: WoListUi, selected: Boolean, onClick: () -> Unit) {
    val c = Lp.colors
    val shape = LpShapes.Card
    Column(
        Modifier.fillMaxWidth().clip(shape).background(if (selected) c.accSoft else c.surf).border(if (selected) 2.dp else 1.dp, if (selected) c.acc else c.line, shape)
            .clickable(role = Role.Button, onClick = onClick).semantics { this.selected = selected }
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(row.wo.toString(), style = LpType.ValueMedium, color = c.fg, modifier = Modifier.weight(1f), maxLines = 1)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                LpIcon(LpIcons.Calendar, null, size = 20.dp, tint = c.soft)
                Text(WoFmt.shortDayTime(row.closedAt, LocalWoClock.current.zone), style = LpType.Body, color = c.soft, maxLines = 1)
            }
        }
        val sub = listOfNotNull(row.device, row.program).joinToString(Fmt.DOT).ifEmpty { Fmt.DASH }
        Text(sub, style = LpType.Row, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            OutcomeChip(row.outcome, row.closedReason)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Sold", style = LpType.Small, color = c.soft)
                Text(WoFmt.money(row.lastCartValue), style = LpType.BodyStrong, color = c.fg, maxLines = 1)
            }
        }
        if (state.showStore) Text(state.storeName(row.store), style = LpType.Small, color = c.soft, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Box(Modifier.fillMaxWidth().padding(vertical = 4.dp).height(1.dp).background(c.line))
        CustomerLine(row, state)
    }
}

/** "Parts" on a closed work order: what was sold (name, quantity, price, label); a dash when none were read. A label opens its Retrace page. */
@Composable
fun PartsCard(parts: List<WoPartRow>, modifier: Modifier = Modifier, onOpenLabel: (String) -> Unit = {}) {
    val c = Lp.colors
    LpCard(modifier) {
        CardLabel("Parts", trailing = if (parts.isEmpty()) null else ({ Text(WoFmt.money(parts.sumOf { (it.price ?: 0.0) * (it.quantity ?: 1.0) }), style = LpType.Label, color = c.fg) }))
        if (parts.isEmpty()) {
            Spacer(Modifier.height(10.dp))
            Text(Fmt.DASH, style = LpType.Body, color = c.soft)
        }
        parts.forEach { p ->
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    val qty = p.quantity?.takeIf { it != 1.0 }?.let { " × ${if (it % 1.0 == 0.0) it.toInt() else it}" }.orEmpty()
                    Text((p.name ?: Fmt.DASH) + qty, style = LpType.Body, color = c.fg)
                    val label = p.label
                    if (label != null) Text(label, style = LpType.Small, color = c.soft, maxLines = 1,
                        modifier = Modifier.heightIn(min = 28.dp).clickable(role = Role.Button, onClickLabel = "Open label", onClick = { onOpenLabel(label) }))
                    else Text(Fmt.DASH, style = LpType.Small, color = c.soft, maxLines = 1)
                }
                Text(WoFmt.money(p.price), style = LpType.Body, color = c.fg, modifier = Modifier.padding(start = 12.dp))
            }
        }
    }
}

/** "Changes" on a closed work order: status and next update, as the tracker saw them change; a dash when there are none. */
@Composable
fun ChangesCard(changes: List<WoChange>, modifier: Modifier = Modifier) {
    val c = Lp.colors
    val zone = LocalWoClock.current.zone
    val shown = changes.filter { it.field == "status" || it.field == "nextUpdate" }
    fun value(ch: WoChange, v: String?): String = when {
        v == null -> Fmt.DASH
        ch.field == "nextUpdate" -> WoFmt.shortDayTime(v, zone)
        else -> v
    }
    LpCard(modifier) {
        CardLabel("Changes", trailing = if (shown.isEmpty()) null else ({ Text(shown.size.toString(), style = LpType.Label, color = c.soft) }))
        if (shown.isEmpty()) {
            Spacer(Modifier.height(10.dp))
            Text(Fmt.DASH, style = LpType.Body, color = c.soft)
        }
        shown.forEachIndexed { i, ch ->
            Box(Modifier.fillMaxWidth().padding(vertical = 12.dp).height(1.dp).background(c.line))
            Row(verticalAlignment = Alignment.Top) {
                Text(if (ch.field == "status") "Status" else "Next update", style = LpType.BodyStrong, color = c.fg, modifier = Modifier.weight(1f))
                Text(WoFmt.shortDayTime(ch.at, zone), style = LpType.Small, color = c.soft, maxLines = 1, textAlign = TextAlign.End, modifier = Modifier.padding(start = 12.dp, top = 2.dp))
            }
            Spacer(Modifier.height(2.dp))
            Text(value(ch, ch.old) + " → " + value(ch, ch.new), style = LpType.Body, color = c.soft)
        }
    }
}
